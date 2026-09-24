"""
app/services/timeline_builder.py
=================================
Builds the final JSON payload sent to the UXP panel for timeline placement.
This is the data contract between backend and frontend.
"""
from typing import List, Dict
from app.core.config import settings


def build_timeline_payload(
    phrases: List[Dict],
    rendered_assets: List[Dict],
    sfx_enabled: bool,
    sfx_asset_url: str,
    style: Dict,
    caption_track_index: int = 1,
    sfx_track_index: int = 3,
) -> Dict:
    """
    Merges phrase data with rendered asset paths and SFX positions.

    Args:
        phrases:           Output of group_words_into_phrases()
        rendered_assets:   Output of render_phrase_batch()
        sfx_enabled:       Whether to add SFX clips
        sfx_asset_url:     CDN URL of the click/pop SFX file
        style:             User style config
        caption_track_index: 0-based video track index (1 = V2)
        sfx_track_index:     0-based audio track index (3 = A4)

    Returns:
        Timeline payload dict consumed by usePremiere.js
    """
    caption_clips = []
    sfx_clips = []

    for phrase, asset in zip(phrases, rendered_assets):
        caption_clips.append({
            "asset_url": _make_cdn_url(asset["local_path"]),
            "startSec": phrase["start"],
            "durationSec": phrase["duration"],
            "trackIndex": caption_track_index,
            "type": "video",
            "phrase": phrase["phrase"],
        })

        if sfx_enabled:
            for word in phrase["words"]:
                sfx_clips.append({
                    "asset_url": sfx_asset_url,
                    "startSec": word["start"],
                    "trackIndex": sfx_track_index,
                    "type": "audio",
                    "word": word["word"],
                })

    return {
        "caption_clips": caption_clips,
        "sfx_clips": sfx_clips,
        "total_clips": len(caption_clips),
        "total_sfx": len(sfx_clips),
        "style_summary": {
            "font_family": style.get("font_family"),
            "animation_preset": style.get("animation_preset"),
            "caption_mode": style.get("caption_mode"),
        },
    }


def _make_cdn_url(local_path: str) -> str:
    """
    Converts a worker-side S3 key (or legacy local path) to a download URL.
    Workers store the S3 key in `local_path`; this builds the public URL.
    """
    # Workers pass S3-style keys like "renders/<job_id>/caption_0000.mov".
    # Serve them via the API's static mount (CDN_BASE_URL=http://localhost:8000/assets).
    key = local_path.replace("\\", "/").lstrip("/")
    return f"{settings.CDN_BASE_URL.rstrip('/')}/{key}"
