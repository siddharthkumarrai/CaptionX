"""
app/core/config.py
==================
Pydantic Settings — all configuration from environment variables.
Never hardcode secrets. Copy .env.example → .env for local dev.
"""
from typing import List
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
    )

    # ── App ───────────────────────────────────────────────────────────────────
    ENVIRONMENT: str = "development"  # development | production
    SECRET_KEY: str = "CHANGE_ME_IN_PRODUCTION_32_CHARS_MIN"
    ALLOWED_ORIGINS: List[str] = [
        "http://localhost:3000",
        "https://captionx.app",
        "null",  # UXP panels send Origin: null
    ]

    # ── JWT ───────────────────────────────────────────────────────────────────
    JWT_SECRET: str = "CHANGE_ME_JWT_SECRET"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30

    # ── Database ──────────────────────────────────────────────────────────────
    DATABASE_URL: str = "postgresql+asyncpg://captionx:captionx@localhost:5432/captionx"

    # ── Redis / Celery ────────────────────────────────────────────────────────
    REDIS_URL: str = "redis://localhost:6379/0"
    CELERY_BROKER_URL: str = "redis://localhost:6379/0"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6379/1"

    # ── S3 / Cloudflare R2 ────────────────────────────────────────────────────
    S3_ENDPOINT_URL: str = ""          # Empty = AWS S3; set for R2/MinIO
    S3_ACCESS_KEY: str = ""
    S3_SECRET_KEY: str = ""
    S3_BUCKET: str = "captionx-assets"
    S3_REGION: str = "us-east-1"
    CDN_BASE_URL: str = "https://cdn.captionx.app"  # Public CDN URL for assets
    LOCAL_STORAGE_DIR: str = "/app/storage"

    # ── WhisperX ─────────────────────────────────────────────────────────────
    WHISPER_MODEL: str = "large-v3-turbo"   # large-v3-turbo | medium | base
    WHISPER_DEVICE: str = "auto"            # auto | cuda | cpu (auto falls back to cpu)
    WHISPER_COMPUTE_TYPE: str = "auto"      # auto | float16 | int8 (int8 on cpu)
    # Tuning for CPU execution; ignored on GPU
    WHISPER_BATCH_SIZE: int = 16           # transcription batch size
    WHISPER_CPU_THREADS: int = 8           # torch/cpu thread count on non-NVIDIA hosts
    MAX_UPLOAD_SIZE_MB: int = 2048          # 2 GB

    # ── WhisperX accuracy tuning ───────────────────────────────────────────────
    # WhisperX 3.x always runs its bundled pyannote VAD before decoding and the
    # first speech chunk starts at the first VAD trigger — every sample before
    # that trigger is NEVER decoded. Quiet/faded intros (soft first words, music
    # beds) sit below the default onset=0.50 and lose the opening words. Lowering
    # the thresholds makes the VAD open on soft speech, and the edge-recovery
    # pass below re-decodes the head/tail that is still missed.
    WHISPER_VAD_ONSET: float = 0.30         # 0..1 — lower = more sensitive speech onset
    WHISPER_VAD_OFFSET: float = 0.20        # 0..1 — lower = holds speech regions longer
    WHISPER_MIN_WORD_SCORE: float = 0.15    # drop alignment noise below this confidence
    WHISPER_NORMALIZE_AUDIO: bool = True    # ffmpeg loudness-normalise before decoding
    # Re-decode any untranscribed head/tail and merge it back in (absolute times).
    WHISPER_EDGE_RECOVERY: bool = True
    WHISPER_EDGE_PAD_SECONDS: float = 0.75  # silence padding / overlap per edge pass
    WHISPER_HEAD_GAP_SECONDS: float = 0.20  # head gap that triggers a recovery pass
    WHISPER_TAIL_GAP_SECONDS: float = 0.60  # tail gap that triggers a recovery pass
    WHISPER_HEAD_WINDOW_SECONDS: float = 8.0  # head window when the model returns nothing

    # ── Plans & Limits ────────────────────────────────────────────────────────
    FREE_MONTHLY_JOBS: int = 3
    FREE_WATERMARK: bool = True

    # ── Testing / Development ────────────────────────────────────────────────────
    # Emails that bypass usage limits and plan checks (testing only).
    TESTING_EMAILS: List[str] = []

    # ── Lemon Squeezy (Payments) ──────────────────────────────────────────────
    LEMON_SQUEEZY_API_KEY: str = ""
    LEMON_SQUEEZY_WEBHOOK_SECRET: str = ""
    LEMON_SQUEEZY_STORE_ID: str = ""
    LEMON_SQUEEZY_PRODUCT_PRO: str = ""
    LEMON_SQUEEZY_PRODUCT_AGENCY: str = ""


settings = Settings()
