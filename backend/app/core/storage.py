"""app/core/storage.py — S3/R2 upload/download helpers."""
import json
import boto3
from botocore.client import Config
from app.core.config import settings

_s3 = None

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
    s3 = _get_client()
    s3.put_object(
        Bucket=settings.S3_BUCKET,
        Key=key,
        Body=content,
        ContentType=content_type,
    )


def upload_json_to_s3(data: dict, key: str):
    s3 = _get_client()
    s3.put_object(
        Bucket=settings.S3_BUCKET,
        Key=key,
        Body=json.dumps(data).encode(),
        ContentType="application/json",
    )


def download_from_s3(key: str, local_path: str):
    s3 = _get_client()
    s3.download_file(settings.S3_BUCKET, key, local_path)


def download_json_from_s3(key: str) -> dict:
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
