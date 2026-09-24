"""
app/api/jobs.py
===============
Job endpoints: upload, transcribe, render, status, WebSocket streaming.
"""
import json
import uuid
import asyncio
from datetime import datetime, timezone
from typing import Optional

from fastapi import (
    APIRouter, Depends, HTTPException, UploadFile, File, Form,
    WebSocket, WebSocketDisconnect,
)
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, AsyncSessionLocal
from app.core.config import settings
from app.api.auth import get_current_user
from app.models.user import User, Plan
from app.models.job import Job, JobStatus, JobType
from app.core.storage import upload_file_to_s3
from app.workers.celery_app import celery_app

router = APIRouter()

MAX_BYTES = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024

ALLOWED_EXTENSIONS = {
    ".mp4", ".mov", ".avi", ".mkv", ".webm",
    ".mp3", ".wav", ".m4a", ".aac", ".flac",
}


# ── Schemas ───────────────────────────────────────────────────────────────────

class RenderRequest(BaseModel):
    job_id: str
    style_config: dict


class TranscriptUpdateRequest(BaseModel):
    words: list
    phrases: list


class JobStatusResponse(BaseModel):
    job_id: str
    status: str
    progress: int
    message: Optional[str]
    result: Optional[dict]


# ── Helper ────────────────────────────────────────────────────────────────────

async def _check_rate_limit(user: User, db: AsyncSession):
    """Enforce free plan monthly limit. Reset counter on new month."""
    if user.email in settings.TESTING_EMAILS:
        return  # testing/dev accounts: bypass all limits

    if user.plan != Plan.free:
        return  # Pro/Agency: unlimited

    now = datetime.now(timezone.utc)
    # Reset monthly counter if it's a new month
    if (
        user.monthly_reset_at.year < now.year
        or user.monthly_reset_at.month < now.month
    ):
        user.monthly_jobs_used = 0
        user.monthly_reset_at = now

    if user.monthly_jobs_used >= settings.FREE_MONTHLY_JOBS:
        raise HTTPException(
            status_code=429,
            detail=f"Free plan limit ({settings.FREE_MONTHLY_JOBS} jobs/month) reached. Upgrade to Pro.",
        )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/transcribe")
async def create_transcribe_job(
    file: UploadFile = File(...),
    language: str = Form("auto"),
    caption_mode: str = Form("two_words"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Rate limit check
    await _check_rate_limit(user, db)

    # File validation
    ext = "." + file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=422, detail=f"Unsupported file type: {ext}")

    content = await file.read()
    if len(content) > MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Max {settings.MAX_UPLOAD_SIZE_MB} MB",
        )

    # Upload to S3
    s3_key = f"uploads/{user.id}/{uuid.uuid4()}{ext}"
    await upload_file_to_s3(content, s3_key, file.content_type)

    # Create job record
    job = Job(
        user_id=user.id,
        type=JobType.transcribe,
        status=JobStatus.pending,
        input_file_key=s3_key,
        style_config_json=json.dumps({"language": language, "caption_mode": caption_mode}),
    )
    db.add(job)
    user.monthly_jobs_used += 1
    await db.flush()
    job_id = job.id
    # Commit BEFORE dispatching: send_task runs in a separate process and the
    # worker only sees committed rows. Dispatching after flush-but-before-commit
    # is a race — the fast worker SELECTs the job before COMMIT lands, finds
    # nothing, and returns silently while the panel sits at 0% forever.
    # (get_db commits on exit, but by then the worker may already have run.)
    await db.commit()

    # Dispatch to Celery GPU queue
    celery_app.send_task(
        "workers.transcribe",
        args=[job_id, s3_key, language, caption_mode],
        queue="gpu",
    )

    return {"job_id": job_id, "status": "pending"}


@router.post("/render")
async def create_render_job(
    req: RenderRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Verify parent transcription job belongs to user
    result = await db.execute(
        select(Job).where(Job.id == req.job_id, Job.user_id == user.id)
    )
    parent_job = result.scalar_one_or_none()
    if not parent_job:
        raise HTTPException(status_code=404, detail="Transcription job not found")
    if parent_job.status != JobStatus.done:
        raise HTTPException(status_code=400, detail="Transcription job not complete yet")

    render_job = Job(
        user_id=user.id,
        type=JobType.render,
        status=JobStatus.pending,
        parent_job_id=req.job_id,
        style_config_json=json.dumps(req.style_config),
    )
    db.add(render_job)
    await db.flush()
    render_job_id = render_job.id
    # Same commit-before-dispatch rule as transcribe: the render worker runs in
    # a separate process and must see a committed job row on first SELECT.
    await db.commit()

    # Dispatch to CPU queue (PNG rendering doesn't need GPU)
    celery_app.send_task(
        "workers.render",
        args=[render_job_id, req.job_id, req.style_config],
        queue="cpu",
    )

    return {"render_job_id": render_job_id, "status": "pending"}


@router.get("/{job_id}", response_model=JobStatusResponse)
async def get_job_status(
    job_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Job).where(Job.id == job_id, Job.user_id == user.id)
    )
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    result_data = None
    if job.result_json:
        try:
            result_data = json.loads(job.result_json)
        except json.JSONDecodeError:
            pass

    return JobStatusResponse(
        job_id=job.id,
        status=job.status,
        progress=job.progress,
        message=job.message,
        result=result_data,
    )


@router.put("/{job_id}/transcript")
async def update_transcript(
    job_id: str,
    body: TranscriptUpdateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Persist user-edited words/phrases (Review transcript → Save edits).

    The render worker prefers this saved copy over the S3 object so edits
    survive re-render and are honored at Place time. Regroups phrases from
    words when word text changed so preview + render stay consistent, and
    mirrors the saved copy back to S3 for durability.
    """
    result = await db.execute(
        select(Job).where(Job.id == job_id, Job.user_id == user.id)
    )
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    words = [dict(w) for w in (body.words or [])]
    if not words:
        raise HTTPException(status_code=422, detail="Transcript needs at least one word")

    caption_mode = "two_words"
    try:
        saved_cfg = json.loads(job.style_config_json or "{}")
        caption_mode = saved_cfg.get("caption_mode", "two_words")
    except (json.JSONDecodeError, AttributeError):
        pass

    # Regroup phrases from the (possibly edited) words so timing/text are
    # consistent — import locally to avoid a hard dependency at module load.
    try:
        from app.services.transcription import group_words_into_phrases
        phrases = group_words_into_phrases(words, mode=caption_mode)
    except Exception:
        phrases = body.phrases or []

    payload = {
        "job_id": job.id,
        "words": words,
        "phrases": phrases,
        "word_count": len(words),
        "phrase_count": len(phrases),
    }
    job.result_json = json.dumps(payload)
    await db.commit()

    try:
        upload_json_to_s3(payload, f"results/{job.id}/transcript.json")
    except Exception:
        pass  # DB copy is authoritative; S3 mirror is best-effort

    return {"ok": True, "word_count": len(words), "phrase_count": len(phrases)}


@router.delete("/{job_id}")
async def delete_job(
    job_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Delete a job and its child render jobs (own jobs only).

    Used by the panel's "Remove transcript" action. S3 objects are left in
    place (cheap, content-addressed); only the DB rows are removed so a
    re-transcribe starts fully clean with no stale result to resurrect.
    """
    result = await db.execute(
        select(Job).where(Job.id == job_id, Job.user_id == user.id)
    )
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    child_res = await db.execute(
        delete(Job).where(Job.parent_job_id == job_id, Job.user_id == user.id)
    )
    await db.delete(job)
    await db.commit()
    return {
        "ok": True,
        "deleted": job_id,
        "deleted_renders": child_res.rowcount or 0,
    }


@router.get("/{job_id}/export.srt")
async def export_srt(
    job_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Download the transcript as an SRT file (importable into Premiere)."""
    result = await db.execute(
        select(Job).where(Job.id == job_id, Job.user_id == user.id)
    )
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    transcript = None
    if job.result_json:
        try:
            transcript = json.loads(job.result_json)
        except json.JSONDecodeError:
            transcript = None
    if not transcript:
        try:
            transcript = download_json_from_s3(f"results/{job.id}/transcript.json")
        except FileNotFoundError:
            transcript = None
    phrases = (transcript or {}).get("phrases", []) if transcript else []
    if not phrases:
        raise HTTPException(status_code=404, detail="No transcript available yet")

    def _ts(sec: float) -> str:
        ms = max(0, int(round(float(sec) * 1000)))
        h, rem = divmod(ms, 3600000)
        m, rem = divmod(rem, 60000)
        s, ms = divmod(rem, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    lines = []
    for i, p in enumerate(phrases, 1):
        lines.append(str(i))
        lines.append(f"{_ts(p['start'])} --> {_ts(p['end'])}")
        lines.append(p.get("phrase", ""))
        lines.append("")
    return Response(
        content="\n".join(lines),
        media_type="application/x-subrip",
        headers={"Content-Disposition": f"attachment; filename=captionx-{job_id}.srt"},
    )


@router.get("/{job_id}/preview.mp4")
async def preview_video(
    job_id: str,
    token: str = "",
    db: AsyncSession = Depends(get_db),
):
    """H.264 playback proxy of the timeline media for the panel preview.

    Phone/camera footage is often HEVC/H.265, which no Chromium build
    (including CEP) can decode — a <video> pointed at the original stays
    black with audio only. This endpoint transcodes once to 720p H.264
    (+faststart) and streams it with range support, so the studio and the
    transcript review play real motion for any source codec.

    Auth comes from ``?token=`` because <video> elements cannot send
    Authorization headers. The file is cached next to the transcript
    (``results/{job_id}/preview.mp4``) and regenerated only when missing.
    """
    from fastapi.responses import FileResponse, RedirectResponse

    from app.core.security import decode_token
    from app.core import storage as _storage

    try:
        payload = decode_token(token or "")
    except Exception:
        raise HTTPException(status_code=401, detail="Not authenticated")
    result = await db.execute(select(User).where(User.id == payload.get("sub")))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")

    result = await db.execute(
        select(Job).where(Job.id == job_id, Job.user_id == user.id)
    )
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != JobStatus.done or not job.input_file_key:
        raise HTTPException(status_code=409, detail="Transcript not ready yet")

    preview_key = f"results/{job_id}/preview.mp4"

    # ── Serve from cache when present ─────────────────────────────────────
    if _storage._use_local_storage():
        from pathlib import Path

        cached = Path(_storage._local_path(preview_key))
        if cached.exists() and cached.stat().st_size > 0:
            return FileResponse(str(cached), media_type="video/mp4")
    else:
        # S3 mode: redirect only when the object actually exists.
        try:
            _storage._get_client().head_object(
                Bucket=settings.S3_BUCKET, Key=preview_key
            )
            return RedirectResponse(
                _storage.get_presigned_url(preview_key), status_code=302
            )
        except Exception:
            pass  # not cached — fall through and generate

    # ── Transcode the uploaded timeline media once ────────────────────────
    import os
    import subprocess
    import tempfile

    fd, src_path = tempfile.mkstemp(prefix="preview-src-", suffix=".mp4")
    os.close(fd)
    fd, out_path = tempfile.mkstemp(prefix="preview-out-", suffix=".mp4")
    os.close(fd)
    try:
        _storage.download_from_s3(job.input_file_key, src_path)
        proc = subprocess.run(
            [
                "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                "-i", src_path,
                "-vf", "scale=-2:720",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart",
                "-t", "600",
                out_path,
            ],
            capture_output=True,
            timeout=1200,
        )
        if proc.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            raise HTTPException(
                status_code=500,
                detail="Preview transcode failed for this media file.",
            )
        with open(out_path, "rb") as f:
            content = f.read()
        if _storage._use_local_storage():
            from pathlib import Path

            dest = Path(_storage._local_path(preview_key))
            dest.write_bytes(content)
            return FileResponse(str(dest), media_type="video/mp4")
        await _storage.upload_file_to_s3(content, preview_key, "video/mp4")
        return RedirectResponse(_storage.get_presigned_url(preview_key), status_code=302)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Preview unavailable: {e}")
    finally:
        for p in (src_path, out_path):
            try:
                os.unlink(p)
            except Exception:
                pass


@router.websocket("/ws/{job_id}")
async def job_websocket(
    websocket: WebSocket,
    job_id: str,
):
    """
    WebSocket endpoint for real-time job progress streaming.

    Each poll iteration opens a *fresh* AsyncSession so it sees committed
    updates from the Celery workers (a long-lived session freezes its
    transaction snapshot and would never observe progress changes — this
    was the root cause of the panel showing 0% / "Connected — processing…").
    """
    await websocket.accept()
    timeout = 600  # 10 min max
    elapsed = 0
    last_status = None
    last_progress = -1
    last_message = None

    try:
        while elapsed < timeout:
            async with AsyncSessionLocal() as db:
                result = await db.execute(select(Job).where(Job.id == job_id))
                job = result.scalar_one_or_none()

            if not job:
                await websocket.send_json({"status": "error", "message": "Job not found"})
                break

            progress_changed = job.progress != last_progress
            message_changed = (job.message or "") != last_message
            if job.status != last_status or progress_changed or message_changed:
                payload = {
                    "status": job.status,
                    "progress": job.progress,
                    "message": job.message or "",
                }
                if job.status == JobStatus.done and job.result_json:
                    payload["result"] = json.loads(job.result_json)
                await websocket.send_json(payload)
                last_status = job.status
                last_progress = job.progress
                last_message = job.message or ""

            if job.status in (JobStatus.done, JobStatus.error):
                break

            await asyncio.sleep(2)
            elapsed += 2

        if elapsed >= timeout:
            try:
                await websocket.send_json({"status": "error", "message": "Job timed out"})
            except RuntimeError:
                pass  # client already gone

    except WebSocketDisconnect:
        pass
    except RuntimeError:
        # Starlette raises once the client has closed the socket mid-send —
        # not a server bug, just stop polling quietly.
        pass
    except Exception as e:
        try:
            await websocket.send_json({"status": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except RuntimeError:
            pass  # already closed by the client / disconnect handler
