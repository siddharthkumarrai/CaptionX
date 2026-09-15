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

    # ── WhisperX ─────────────────────────────────────────────────────────────
    WHISPER_MODEL: str = "large-v3-turbo"   # large-v3-turbo | medium | base
    WHISPER_DEVICE: str = "auto"            # auto | cuda | cpu
    WHISPER_COMPUTE_TYPE: str = "auto"      # auto | float16 | int8
    MAX_UPLOAD_SIZE_MB: int = 2048          # 2 GB

    # ── Plans & Limits ────────────────────────────────────────────────────────
    FREE_MONTHLY_JOBS: int = 3
    FREE_WATERMARK: bool = True

    # ── Lemon Squeezy (Payments) ──────────────────────────────────────────────
    LEMON_SQUEEZY_API_KEY: str = ""
    LEMON_SQUEEZY_WEBHOOK_SECRET: str = ""
    LEMON_SQUEEZY_STORE_ID: str = ""
    LEMON_SQUEEZY_PRODUCT_PRO: str = ""
    LEMON_SQUEEZY_PRODUCT_AGENCY: str = ""


settings = Settings()
