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
                return

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
                transcript = download_json_from_s3(transcript_key)
                phrases = transcript["phrases"]

                if not phrases:
                    raise ValueError("No phrases found in transcript")

                await update(JobStatus.running, 15, f"Rendering {len(phrases)} captions…")

                # ── Render PNGs + MOVs ────────────────────────────────────────
                with tempfile.TemporaryDirectory() as tmpdir:
                    rendered = render_phrase_batch(
                        phrases=phrases,
                        style=style_config,
                        output_dir=tmpdir,
                    )

                    await update(JobStatus.running, 70, "Uploading rendered assets…")

                    # ── Upload each MOV to S3 ────────────────────────────────
                    for asset in rendered:
                        s3_key = f"renders/{render_job_id}/{os.path.basename(asset['local_path'])}"
                        with open(asset["local_path"], "rb") as f:
                            content = f.read()
                        upload_file_to_s3(content, s3_key, "video/quicktime")
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
