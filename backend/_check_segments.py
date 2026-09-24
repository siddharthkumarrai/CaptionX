"""Temporary diagnostic #2: show raw WhisperX segment output for the asset."""
import glob
import sys

from app.services.transcription import (
    _asr_options,
    _load_audio,
    _resolve_compute_type,
    _resolve_device,
    _vad_options,
    settings,
)
from app.services.hardware import detect_hardware
import whisperx

candidates = sorted(glob.glob("/app/assets/*.mp4"))
audio = _load_audio(candidates[0])
print("DURATION", round(audio.size / 16000, 2))
print("VAD_OPTS", _vad_options())
print("ASR_OPTS", _asr_options())

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
result = model.transcribe(audio, batch_size=hw.batch_size)
print("LANG", result.get("language"))
for i, seg in enumerate(result.get("segments", [])):
    print(
        f"SEG{i} [{seg.get('start'):.3f} -> {seg.get('end'):.3f}] {seg.get('text')!r} "
        f"no_speech={seg.get('no_speech_prob')}"
    )
