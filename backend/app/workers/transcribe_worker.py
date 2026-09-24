"""
app/workers/transcribe_worker.py
=================================
Celery task: download audio from S3, run WhisperX, save results, push progress.
Runs on the GPU queue (celery-gpu Docker service).
"""
import json
import os
import tempfile
from datetime import datetime, timezone

from celery import Task
from app.workers.celery_app import celery_app
from app.services.transcription import transcribe_audio, group_words_into_phrases
from app.core.storage import download_from_s3, upload_json_to_s3
from app.core.database import AsyncSessionLocal
from app.models.job import Job, JobStatus
from app.models.user import User


class TranscribeTask(Task):
    """Custom Task base to hold model in memory between calls."""
    abstract = True


@celery_app.task(
    bind=True,
    base=TranscribeTask,
    name="workers.transcribe",
    queue="gpu",
    max_retries=2,
    default_retry_delay=30,
    time_limit=3600,  # 1 hour hard limit
    soft_time_limit=3300,
)
def transcribe_task(self, job_id: str, s3_key: str, language: str, caption_mode: str):
    """
    Celery task for full transcription pipeline.
    Progress updates: 10% (download) → 30% (whisper) → 80% (align) → 100% (done)
    """
    import asyncio

    async def _run():
        async with AsyncSessionLocal() as db:
            job = await db.get(Job, job_id)
            if not job:
                # The API now commits before dispatching, so a missing row here
                # is unexpected — retry shortly instead of silently dropping the
                # job (a silent return leaves the panel stuck at 0% forever).
                raise self.retry(
                    exc=RuntimeError(f"Transcribe job {job_id} not visible yet, retrying"),
                    countdown=5,
                )

            async def update(status, progress, message=None):
                job.status = status
                job.progress = progress
                if message:
                    job.message = message
                await db.commit()

            try:
                await update(JobStatus.running, 5, "Starting transcription…")

                # ── Download from S3 ──────────────────────────────────────────
                with tempfile.NamedTemporaryFile(suffix=os.path.splitext(s3_key)[1], delete=False) as tmp:
                    tmp_path = tmp.name

                await update(JobStatus.running, 10, "Downloading audio…")
                download_from_s3(s3_key, tmp_path)

                # ── WhisperX transcription ────────────────────────────────────
                await update(JobStatus.running, 20, "Running Whisper transcription…")
                recovery_stats = {}
                words = transcribe_audio(tmp_path, language=language, stats=recovery_stats)
                recovered = int(recovery_stats.get("recovered_total") or 0)

                # ── Group into phrases ────────────────────────────────────────
                await update(JobStatus.running, 85, "Grouping into phrases…")
                phrases = group_words_into_phrases(words, mode=caption_mode)

                # ── Build result ──────────────────────────────────────────────
                result = {
                    "job_id": job_id,
                    "words": words,
                    "phrases": phrases,
                    "word_count": len(words),
                    "phrase_count": len(phrases),
                    "recovered_words": recovered,
                }

                # Upload result JSON to S3 for persistence
                result_key = f"results/{job_id}/transcript.json"
                upload_json_to_s3(result, result_key)

                job.result_json = json.dumps(result)
                job.status = JobStatus.done
                job.progress = 100
                job.message = (
                    f"Complete — {len(phrases)} captions generated"
                    + (f" ({recovered} missing words recovered)" if recovered else "")
                )
                job.completed_at = datetime.now(timezone.utc)
                await db.commit()

            except Exception as e:
                job.status = JobStatus.error
                job.message = str(e)[:450]
                await db.commit()
                raise

            finally:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass

    asyncio.get_event_loop().run_until_complete(_run())
