"""Temporary diagnostic #3: VAD chunks + head-window decode."""
import glob

import numpy as np
import whisperx

from app.services.hardware import detect_hardware
from app.services.transcription import (
    _align_words,
    _asr_options,
    _decode_window,
    _first_voice_time,
    _load_align_model,
    _load_audio,
    _resolve_compute_type,
    _resolve_device,
    _vad_options,
    settings,
)

audio = _load_audio(sorted(glob.glob("/app/assets/*.mp4"))[0])
hw = detect_hardware()
device, load_opts = _resolve_device(hw)
model = whisperx.load_model(
    settings.WHISPER_MODEL,
    device,
    compute_type=_resolve_compute_type(hw),
    asr_options=_asr_options(),
    vad_options=_vad_options(),
    language=None,
    **{k: v for k, v in load_opts.items() if k != "device"},
)

print("FIRST_VOICE", _first_voice_time(audio))

# Raw VAD chunks as WhisperX 3.x computes them.
vad_params = {**model.vad_model.vad_params, **_vad_options()}
vad_segments = model.vad_model({"waveform": torch_audio, "sample_rate": 16000}.__class__) if False else None

import torch  # noqa: E402

vad_in = torch.from_numpy(audio).unsqueeze(0)
segments = model.vad_model({"waveform": vad_in, "sample_rate": 16000})
from whisperx.vads import merge_chunks  # noqa: E402

merged = merge_chunks(
    segments, model._vad_params["chunk_size"], onset=_vad_options()["vad_onset"], offset=_vad_options()["vad_offset"]
)
print("VAD_CHUNKS", [(round(s["start"], 3), round(s["end"], 3)) for s in merged])

align_model, metadata = _load_align_model("en", device)

for w_start, w_end in [(0.0, 8.0), (0.0, 24.2), (0.0, 5.0)]:
    a = int(w_start * 16000)
    b = int(min(audio.size, w_end * 16000))
    words = _decode_window(model, audio[a:b], w_start, align_model, metadata, device, hw.batch_size)
    print(f"WINDOW {w_start}-{w_end} -> {len(words)} words")
    print("   ", [w["word"] for w in words[:20]])
    if words:
        print("    t0", words[0]["start"], "tN", words[-1]["end"])
