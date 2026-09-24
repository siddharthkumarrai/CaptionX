"""
app/api/auth.py
===============
Authentication endpoints: register, login, refresh, validate, logout.
"""
import json
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Response, Cookie
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import (
    hash_password, verify_password,
    create_access_token, create_refresh_token, decode_token,
)
from app.models.user import User, Plan

router = APIRouter()
bearer = HTTPBearer(auto_error=False)


# ── Schemas ───────────────────────────────────────────────────────────────────

class PasswordRequest(BaseModel):
    password: str

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: str) -> str:
        if len(value) < 8:
            raise ValueError("Password must be at least 8 characters")
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Password must be 72 UTF-8 bytes or fewer")
        return value


class RegisterRequest(PasswordRequest):
    email: EmailStr

class LoginRequest(PasswordRequest):
    email: EmailStr
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    plan: str
    credits_remaining: int


# ── Helper ────────────────────────────────────────────────────────────────────

async def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not creds:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(creds.credentials)
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))
    
    result = await db.execute(select(User).where(User.id == payload["sub"]))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return user


def _credits_remaining(user: User) -> int:
    from app.core.config import settings
    if user.plan == Plan.free:
        return max(0, settings.FREE_MONTHLY_JOBS - user.monthly_jobs_used)
    return 9999  # unlimited for Pro / Agency


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/register", response_model=TokenResponse)
async def register(req: RegisterRequest, db: AsyncSession = Depends(get_db)):
    existing = await db.execute(select(User).where(User.email == req.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already registered")
    user = User(
        email=req.email,
        hashed_password=hash_password(req.password),
        plan=Plan.free,
    )
    db.add(user)
    await db.flush()

    return TokenResponse(
        access_token=create_access_token(user.id, {"plan": user.plan, "email": user.email}),
        plan=user.plan,
        credits_remaining=_credits_remaining(user),
    )


@router.post("/login", response_model=TokenResponse)
async def login(req: LoginRequest, response: Response, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == req.email))
    user = result.scalar_one_or_none()
    if not user or not verify_password(req.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account suspended")

    # Set refresh token in httpOnly cookie
    refresh = create_refresh_token(user.id)
    response.set_cookie(
        key="refresh_token",
        value=refresh,
        httponly=True,
        secure=True,
        samesite="strict",
        max_age=30 * 24 * 3600,
    )

    return TokenResponse(
        access_token=create_access_token(user.id, {"plan": user.plan, "email": user.email}),
        plan=user.plan,
        credits_remaining=_credits_remaining(user),
    )


@router.post("/refresh")
async def refresh_token(
    refresh_token: str = Cookie(None),
    db: AsyncSession = Depends(get_db),
):
    if not refresh_token:
        raise HTTPException(status_code=401, detail="No refresh token")
    try:
        payload = decode_token(refresh_token)
        if payload.get("type") != "refresh":
            raise ValueError("Not a refresh token")
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))

    result = await db.execute(select(User).where(User.id == payload["sub"]))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return {"access_token": create_access_token(user.id, {"plan": user.plan})}


@router.get("/validate")
async def validate_token(user: User = Depends(get_current_user)):
    return {
        "valid": True,
        "email": user.email,
        "plan": user.plan,
        "credits_remaining": _credits_remaining(user),
        "features": {
            "watermark": user.plan == Plan.free,
            "all_presets": user.plan != Plan.free,
            "priority_queue": user.plan == Plan.agency,
        },
    }


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie("refresh_token")
    return {"message": "Logged out"}
