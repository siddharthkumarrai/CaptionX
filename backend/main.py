"""
CaptionX FastAPI Backend — main.py
===================================
Entry point. Mounts all routers and configures middleware.
"""
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.staticfiles import StaticFiles

from app.core.config import settings
from app.core.database import init_db
from app.api import auth, jobs


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    await init_db()
    _ensure_bundled_sfx()
    yield
    # Cleanup on shutdown (close DB pool, etc.)


def _ensure_bundled_sfx():
    """Copy the bundled word-pop SFX into the served storage directory.

    The timeline payload points SFX clips at {CDN_BASE_URL}/sfx/*.wav, which
    in development is served from LOCAL_STORAGE_DIR (see the /assets mount
    below). Without this copy that URL 404s and the panel aborts the whole
    placement — captions included. Best-effort: never break startup.
    """
    try:
        from app.core.storage import _use_local_storage, _local_path

        if not _use_local_storage():
            return
        bundled = None
        here = Path(__file__).resolve().parent
        for candidate in (here.parent / "assets" / "sfx", here / "assets" / "sfx", Path("/app/assets/sfx")):
            if candidate.is_dir():
                bundled = candidate
                break
        if bundled is None:
            return
        for wav in sorted(bundled.glob("*.wav")):
            dest = _local_path(f"sfx/{wav.name}")
            if not dest.exists():
                dest.write_bytes(wav.read_bytes())
    except Exception:
        pass  # SFX is garnish — a missing pop must never break the API


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

# ── Local asset server (development) ─────────────────────────────────────────
# Caption MOVs are written to settings.LOCAL_STORAGE_DIR by the render worker
# when ENVIRONMENT=development (no S3 endpoint). timeline_builder builds URLs
# like {CDN_BASE_URL}/renders/<file>; serve that directory here so the UXP
# panel can download the files via downloadFileToTemp().
_storage_root = Path(settings.LOCAL_STORAGE_DIR)
if settings.ENVIRONMENT == "development":
    _storage_root.mkdir(parents=True, exist_ok=True)
    app.mount("/assets", StaticFiles(directory=str(_storage_root)), name="assets")



@app.get("/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}
