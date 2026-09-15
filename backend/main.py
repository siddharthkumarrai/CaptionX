"""
CaptionX FastAPI Backend — main.py
===================================
Entry point. Mounts all routers and configures middleware.
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware

from app.core.config import settings
from app.core.database import init_db
from app.api import auth, jobs, styles, assets


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    await init_db()
    yield
    # Cleanup on shutdown (close DB pool, etc.)


app = FastAPI(
    title="CaptionX API",
    description="Word-level animated caption generation for Adobe Premiere",
    version="1.0.0",
    docs_url="/docs" if settings.ENVIRONMENT != "production" else None,
    redoc_url=None,
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────────────────────
# UXP panels send requests from the plugin's sandboxed context.
# Allow only our own domains in production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if settings.ENVIRONMENT == "production":
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=["api.captionx.app", "*.captionx.app"],
    )

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(jobs.router, prefix="/api/jobs", tags=["jobs"])
app.include_router(styles.router, prefix="/api/styles", tags=["styles"])
app.include_router(assets.router, prefix="/api/assets", tags=["assets"])


@app.get("/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}
