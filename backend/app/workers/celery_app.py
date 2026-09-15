"""app/workers/celery_app.py — Celery application instance."""
from celery import Celery
from app.core.config import settings

celery_app = Celery(
    "captionx",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
    include=["app.workers.transcribe_worker", "app.workers.render_worker"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_routes={
        "workers.transcribe": {"queue": "gpu"},
        "workers.render":     {"queue": "cpu"},
    },
    worker_prefetch_multiplier=1,  # Important for GPU tasks — don't prefetch
    task_acks_late=True,           # Ack only after success (prevents lost tasks on crash)
)
