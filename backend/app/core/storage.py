"""app/core/storage.py — S3/R2 upload/download helpers."""
import json
import os
from pathlib import Path
import boto3
from botocore.client import Config
from app.core.config import settings

_s3 = None


def _use_local_storage():
    return settings.ENVIRONMENT == "development" and not settings.S3_ENDPOINT_URL


def _local_path(key: str) -> Path:
    root = Path(settings.LOCAL_STORAGE_DIR).resolve()
    path = (root / key).resolve()
    if root not in path.parents:
        raise ValueError("Invalid storage key")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path

def _get_client():
    global _s3
    if _s3 is None:
        kwargs = {
            "region_name": settings.S3_REGION,
            "aws_access_key_id": settings.S3_ACCESS_KEY,
            "aws_secret_access_key": settings.S3_SECRET_KEY,
        }
        if settings.S3_ENDPOINT_URL:  # Cloudflare R2 or MinIO
            kwargs["endpoint_url"] = settings.S3_ENDPOINT_URL
            kwargs["config"] = Config(signature_version="s3v4")
        _s3 = boto3.client("s3", **kwargs)
    return _s3


async def upload_file_to_s3(content: bytes, key: str, content_type: str = "application/octet-stream"):
    if _use_local_storage():
        _local_path(key).write_bytes(content)
        return
    s3 = _get_client()
    s3.put_object(
        Bucket=settings.S3_BUCKET,
        Key=key,
        Body=content,
        ContentType=content_type,
    )


def upload_json_to_s3(data: dict, key: str):
    if _use_local_storage():
        _local_path(key).write_text(json.dumps(data), encoding="utf-8")
        return
    s3 = _get_client()
    s3.put_object(
        Bucket=settings.S3_BUCKET,
        Key=key,
        Body=json.dumps(data).encode(),
        ContentType="application/json",
    )


def download_from_s3(key: str, local_path: str):
    if _use_local_storage():
        Path(local_path).write_bytes(_local_path(key).read_bytes())
        return
    s3 = _get_client()
    s3.download_file(settings.S3_BUCKET, key, local_path)


def download_json_from_s3(key: str) -> dict:
    if _use_local_storage():
        return json.loads(_local_path(key).read_text(encoding="utf-8"))
    s3 = _get_client()
    response = s3.get_object(Bucket=settings.S3_BUCKET, Key=key)
    return json.loads(response["Body"].read())


def get_sfx_url(filename: str = "click_pop.wav") -> str:
    return f"{settings.CDN_BASE_URL}/sfx/{filename}"


def get_presigned_url(key: str, expires_in: int = 3600) -> str:
    s3 = _get_client()
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.S3_BUCKET, "Key": key},
        ExpiresIn=expires_in,
    )
