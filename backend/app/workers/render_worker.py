"""
app/workers/render_worker.py
============================
Celery task: fetch transcript result, render PNGs/MOVs, upload to S3, build timeline payload.
Runs on the CPU queue (celery-cpu Docker service).
"""
import json
import os
import tempfile
from datetime import datetime, timezone

from app.workers.celery_app import celery_app
from app.services.renderer import render_phrase_batch
from app.services.timeline_builder import build_timeline_payload
from app.core.storage import download_json_from_s3, upload_file_to_s3, get_sfx_url
from app.core.database import AsyncSessionLocal
from app.models.job import Job, JobStatus
from app.models.user import User


@celery_app.task(
    bind=True,
    name="workers.render",
    queue="cpu",
    max_retries=2,
    default_retry_delay=15,
    time_limit=1800,
    soft_time_limit=1700,
)
def render_task(self, render_job_id: str, transcribe_job_id: str, style_config: dict):
    import asyncio

    async def _run():
        async with AsyncSessionLocal() as db:
            job = await db.get(Job, render_job_id)
            if not job:
                # Same guard as transcribe: never drop silently (panel would
                # sit at 0% forever), retry so the committed row becomes visible.
                raise self.retry(
                    exc=RuntimeError(f"Render job {render_job_id} not visible yet, retrying"),
                    countdown=5,
                )

            async def update(status, progress, message=None):
                job.status = status
                job.progress = progress
                if message:
                    job.message = message
                await db.commit()

            try:
                await update(JobStatus.running, 5, "Loading transcript…")

                # ── Fetch transcript result ────────────────────────────────────
                transcript_key = f"results/{transcribe_job_id}/transcript.json"
                transcript = None
                try:
                    transcript = download_json_from_s3(transcript_key)
                except FileNotFoundError:
                    # Dev/local fallback: transcript may still be on the transcribe
                    # job row if the worker wrote result_json before S3 persistence.
                    transcribe_row = await db.get(Job, transcribe_job_id)
                    if transcribe_row and transcribe_row.result_json:
                        try:
                            transcript = json.loads(transcribe_row.result_json)
                        except (json.JSONDecodeError, AttributeError):
                            transcript = None
                    if not transcript or "phrases" not in transcript:
                        raise ValueError(
                            f"Transcript for job {transcribe_job_id} not found "
                            "(re-run Transcribe to regenerate it)"
                        )
                # Honor user edits made in Review transcript (saved on transcribe job).
                edited = await db.get(Job, transcribe_job_id)
                if edited and edited.result_json:
                    try:
                        saved = json.loads(edited.result_json)
                        if saved.get("words") and saved.get("phrases"):
                            transcript = saved
                    except (json.JSONDecodeError, AttributeError):
                        pass
                phrases = transcript.get("phrases", [])
                words = transcript.get("words", [])

                if not phrases:
                    raise ValueError("No phrases found in transcript")

                await update(JobStatus.running, 15, f"Rendering {len(phrases)} captions…")

                # ── Render PNGs + MOVs (batched so the panel overlay can ──────
                # stream "Rendering caption N of M" progress between batches) ──
                with tempfile.TemporaryDirectory() as tmpdir:
                    rendered = []
                    total = len(phrases)
                    batch = 10
                    for done in range(0, total, batch):
                        chunk = phrases[done:done + batch]
                        rendered.extend(
                            render_phrase_batch(
                                phrases=chunk,
                                style=style_config,
                                output_dir=tmpdir,
                                position=style_config.get("caption_position") or None,
                                start_index=done,
                            )
                        )
                        finished = min(done + batch, total)
                        await update(
                            JobStatus.running,
                            15 + round(55 * finished / total),
                            f"Rendering caption {finished} of {total}…",
                        )

                    await update(JobStatus.running, 70, "Uploading rendered assets…")

                    # ── Upload each MOV to S3 ────────────────────────────────
                    for asset in rendered:
                        s3_key = f"renders/{render_job_id}/{os.path.basename(asset['local_path'])}"
                        with open(asset["local_path"], "rb") as f:
                            content = f.read()
                        await upload_file_to_s3(content, s3_key, "video/quicktime")
                        asset["local_path"] = s3_key  # store S3 key, CDN URL built later

                    await update(JobStatus.running, 90, "Building timeline payload…")

                    # ── Build payload ─────────────────────────────────────────
                    sfx_url = get_sfx_url(style_config.get("sfx_asset", "click_pop.wav"))
                    payload = build_timeline_payload(
                        phrases=phrases,
                        rendered_assets=rendered,
                        sfx_enabled=style_config.get("sfx_enabled", False),
                        sfx_asset_url=sfx_url,
                        style=style_config,
                    )

                job.result_json = json.dumps(payload)
                job.status = JobStatus.done
                job.progress = 100
                job.message = f"Ready — {payload['total_clips']} clips"
                job.completed_at = datetime.now(timezone.utc)
                await db.commit()

            except Exception as e:
                job.status = JobStatus.error
                job.message = str(e)[:450]
                await db.commit()
                raise

    asyncio.get_event_loop().run_until_complete(_run())
