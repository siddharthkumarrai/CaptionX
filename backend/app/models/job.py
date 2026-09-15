"""app/models/job.py — Transcription and render job tracking."""
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Integer, Float, Text, DateTime, Enum as SAEnum, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column
from app.core.database import Base
import enum


class JobStatus(str, enum.Enum):
    pending = "pending"
    running = "running"
    done = "done"
    error = "error"


class JobType(str, enum.Enum):
    transcribe = "transcribe"
    render = "render"


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=False, index=True
    )
    type: Mapped[JobType] = mapped_column(SAEnum(JobType), nullable=False)
    status: Mapped[JobStatus] = mapped_column(SAEnum(JobStatus), default=JobStatus.pending)
    progress: Mapped[int] = mapped_column(Integer, default=0)   # 0–100
    message: Mapped[str] = mapped_column(String(500), nullable=True)

    # Input references
    input_file_key: Mapped[str] = mapped_column(String(500), nullable=True)   # S3 key
    parent_job_id: Mapped[str] = mapped_column(String(36), nullable=True)     # for render jobs

    # Output: stored as JSON string in Text column
    result_json: Mapped[str] = mapped_column(Text, nullable=True)

    # Style config snapshot (JSON)
    style_config_json: Mapped[str] = mapped_column(Text, nullable=True)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    completed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=True)
