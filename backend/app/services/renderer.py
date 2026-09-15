"""
app/services/renderer.py
========================
PNG/MOV caption renderer using Pillow + FFmpeg.
No AE license required. Generates transparent clips for Premiere timeline.
"""
import os
import subprocess
import textwrap
from pathlib import Path
from typing import Dict, List, Tuple
from PIL import Image, ImageDraw, ImageFont

# Default font directory (mounted in Docker / local dev)
FONT_DIR = os.environ.get("FONT_DIR", "/app/assets/fonts")

FONT_MAP = {
    "Montserrat-ExtraBold": "Montserrat-ExtraBold.ttf",
    "Anton":                "Anton-Regular.ttf",
    "Poppins-Bold":         "Poppins-Bold.ttf",
    "Bebas-Neue":           "BebasNeue-Regular.ttf",
    "Impact":               "impact.ttf",
}


# ─── Internal helpers ────────────────────────────────────────────────────────

def _get_font(family: str, size: int) -> ImageFont.FreeTypeFont:
    filename = FONT_MAP.get(family, "Montserrat-ExtraBold.ttf")
    font_path = os.path.join(FONT_DIR, filename)
    if not os.path.exists(font_path):
        # Fallback to default
        font_path = os.path.join(FONT_DIR, "Montserrat-ExtraBold.ttf")
    return ImageFont.truetype(font_path, size)


def _hex_to_rgba(hex_color: str, alpha: int = 255) -> Tuple[int, int, int, int]:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = (int(h[i : i + 2], 16) for i in (0, 2, 4))
    return (r, g, b, alpha)


def _measure_word_widths(draw: ImageDraw.Draw, words: list, font: ImageFont.FreeTypeFont) -> List[float]:
    return [draw.textlength(w["word"] + " ", font=font) for w in words]


# ─── Main render functions ────────────────────────────────────────────────────

def render_caption_png(
    phrase_data: Dict,
    style: Dict,
    output_path: str,
    canvas_width: int = 1920,
    canvas_height: int = 1080,
    active_word_index: int = 0,
) -> str:
    """
    Renders a transparent PNG for one caption phrase.

    Args:
        phrase_data:      {phrase, words: [{word, start, end, score}], ...}
        style:            StyleConfig dict from frontend
        output_path:      Absolute path for output .png
        canvas_width/height: Match Premiere sequence resolution
        active_word_index: Which word to highlight (for "one word at a time" mode)

    Returns:
        output_path (str)
    """
    img = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    font_family = style.get("font_family", "Montserrat-ExtraBold")
    font_size = int(style.get("font_size", 80))
    text_color = style.get("text_color", "#FFFFFF")
    highlight_color = style.get("highlight_color", "#FFD700")
    bg_color = style.get("bg_color", "#000000")
    bg_opacity = float(style.get("bg_opacity", 0.0))
    max_words_per_line = int(style.get("max_words_per_line", 2))

    font = _get_font(font_family, font_size)
    words = phrase_data["words"]

    # Vertical position — bottom third
    y_pos = int(canvas_height * 0.78)

    # Wrap words into lines
    lines = []
    for i in range(0, len(words), max_words_per_line):
        lines.append(words[i : i + max_words_per_line])

    total_text_height = len(lines) * (font_size + 8)
    y_start = y_pos - total_text_height // 2

    for line_words in lines:
        # Measure full line width
        line_text = " ".join(w["word"] for w in line_words)
        line_width = draw.textlength(line_text + " ", font=font)
        x_start = (canvas_width - line_width) // 2

        # Draw background box if enabled
        if bg_opacity > 0:
            pad = 16
            bg_alpha = int(bg_opacity * 255)
            bg_rgba = _hex_to_rgba(bg_color, bg_alpha)
            bbox = [
                x_start - pad,
                y_start - pad // 2,
                x_start + line_width + pad,
                y_start + font_size + pad // 2,
            ]
            draw.rounded_rectangle(bbox, radius=10, fill=bg_rgba)

        # Draw each word with correct color
        x_cursor = x_start
        for i, word_data in enumerate(line_words):
            global_idx = words.index(word_data)
            is_active = global_idx == active_word_index
            color_hex = highlight_color if is_active else text_color
            color_rgba = _hex_to_rgba(color_hex)

            word_text = word_data["word"]
            draw.text((x_cursor, y_start), word_text, font=font, fill=color_rgba)

            # Stroke / shadow for legibility
            for dx, dy in [(-1, -1), (1, -1), (-1, 1), (1, 1)]:
                shadow_color = (0, 0, 0, 160)
                draw.text((x_cursor + dx * 2, y_start + dy * 2), word_text, font=font, fill=shadow_color)
            draw.text((x_cursor, y_start), word_text, font=font, fill=color_rgba)

            x_cursor += draw.textlength(word_text + " ", font=font)

        y_start += font_size + 8

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    img.save(output_path, "PNG", optimize=False)
    return output_path


def render_caption_mov(
    png_path: str,
    duration_sec: float,
    animation_preset: str,
    output_path: str,
    fps: int = 30,
    width: int = 1920,
    height: int = 1080,
) -> str:
    """
    Converts static PNG → animated ProRes 4444 MOV with alpha channel.
    This is what gets imported into Premiere on a video track.

    animation_preset options:
      "none"       — static, no animation
      "fade_in"    — 6-frame opacity fade
      "pop_scale"  — fast scale from 120% → 100%
      "slide_up"   — slide up from 20px below
      "bounce"     — scale bounce: 120% → 95% → 100%
    """
    duration_sec = max(0.1, duration_sec)
    n_frames = max(3, int(duration_sec * fps))

    vf_map = {
        "none":      "null",
        "fade_in":   "fade=in:st=0:d=0.15:alpha=1",
        "pop_scale": (
            f"scale=iw*1.15:ih*1.15,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,"
            f"zoompan=z='if(lte(on,5),1.15-on*0.03,1)'"
            f":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
            f":d=1:s={width}x{height}"
        ),
        "slide_up":  (
            f"format=rgba,"
            f"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'"
            f":a='if(lt(T,0.1),255*T/0.1,255)'"
        ),
        "bounce":    "null",  # implement with overlay + scale filter chain
    }

    vf = vf_map.get(animation_preset, "null")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    cmd = [
        "ffmpeg", "-y",
        "-loop", "1",
        "-i", png_path,
        "-frames:v", str(n_frames),
        "-vf", vf,
        "-c:v", "prores_ks",
        "-profile:v", "4444",   # ProRes 4444 = alpha channel support
        "-pix_fmt", "yuva444p10le",
        "-r", str(fps),
        "-an",                  # no audio track
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg failed: {result.stderr[-500:]}")

    return output_path


def render_phrase_batch(
    phrases: List[Dict],
    style: Dict,
    output_dir: str,
    canvas_width: int = 1920,
    canvas_height: int = 1080,
) -> List[Dict]:
    """
    Renders all phrases in a job to MOV files.
    Returns list of {phrase_index, local_path, start, end, duration}.
    """
    os.makedirs(output_dir, exist_ok=True)
    rendered = []

    animation_preset = style.get("animation_preset", "none")

    for idx, phrase in enumerate(phrases):
        png_path = os.path.join(output_dir, f"caption_{idx:04d}.png")
        mov_path = os.path.join(output_dir, f"caption_{idx:04d}.mov")

        # Render PNG
        render_caption_png(
            phrase_data=phrase,
            style=style,
            output_path=png_path,
            canvas_width=canvas_width,
            canvas_height=canvas_height,
            active_word_index=0,
        )

        # Convert to MOV with animation
        render_caption_mov(
            png_path=png_path,
            duration_sec=phrase["duration"],
            animation_preset=animation_preset,
            output_path=mov_path,
            width=canvas_width,
            height=canvas_height,
        )

        rendered.append({
            "phrase_index": idx,
            "local_path": mov_path,
            "start": phrase["start"],
            "end": phrase["end"],
            "duration": phrase["duration"],
        })

    return rendered
