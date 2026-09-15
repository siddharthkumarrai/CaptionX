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
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.config import settings
from app.api.auth import get_current_user
from app.models.user import User, Plan
from app.models.job import Job, JobStatus, JobType
from app.core.storage import upload_file_to_s3
from app.workers.transcribe_worker import transcribe_task
from app.workers.render_worker import render_task

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


class JobStatusResponse(BaseModel):
    job_id: str
    status: str
    progress: int
    message: Optional[str]
    result: Optional[dict]


# ── Helper ────────────────────────────────────────────────────────────────────

async def _check_rate_limit(user: User, db: AsyncSession):
    """Enforce free plan monthly limit. Reset counter on new month."""
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

    # Dispatch to Celery GPU queue
    transcribe_task.apply_async(
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

    # Dispatch to CPU queue (PNG rendering doesn't need GPU)
    render_task.apply_async(
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


@router.websocket("/ws/{job_id}")
async def job_websocket(
    websocket: WebSocket,
    job_id: str,
    db: AsyncSession = Depends(get_db),
):
    """
    WebSocket endpoint for real-time job progress streaming.
    Polls DB every 2 seconds and pushes updates to client.
    In production, use Redis pub/sub for true push from workers.
    """
    await websocket.accept()
    try:
        last_status = None
        timeout = 600  # 10 min max
        elapsed = 0

        while elapsed < timeout:
            result = await db.execute(select(Job).where(Job.id == job_id))
            job = result.scalar_one_or_none()

            if not job:
                await websocket.send_json({"status": "error", "message": "Job not found"})
                break

            current_status = job.status

            if current_status != last_status or job.progress > 0:
                payload = {
                    "status": job.status,
                    "progress": job.progress,
                    "message": job.message or "",
                }

                if job.status == JobStatus.done and job.result_json:
                    payload["result"] = json.loads(job.result_json)

                await websocket.send_json(payload)
                last_status = current_status

            if current_status in (JobStatus.done, JobStatus.error):
                break

            await asyncio.sleep(2)
            elapsed += 2

        if elapsed >= timeout:
            await websocket.send_json({"status": "error", "message": "Job timed out"})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"status": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        await websocket.close()
