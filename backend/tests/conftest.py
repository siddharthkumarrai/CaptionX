"""Stub out torch/whisperx (GPU-only, multi-GB) so the transcription *logic*
can be unit-tested on any machine. Only pure-Python helpers are exercised —
no model is ever loaded here."""
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_torch = types.ModuleType("torch")
_torch_cuda = types.SimpleNamespace(
    is_available=lambda: False,
    empty_cache=lambda: None,
    get_device_name=lambda _i=0: "",
)
_torch.cuda = _torch_cuda
_torch.set_num_threads = lambda _n: None
sys.modules.setdefault("torch", _torch)

_whisperx = types.ModuleType("whisperx")
_whisperx.load_audio = lambda *_a, **_k: (_ for _ in ()).throw(
    RuntimeError("whisperx stub — model I/O is not available in unit tests")
)
_whisperx.load_model = _whisperx.load_audio
_whisperx.load_align_model = lambda *_a, **_k: (None, None)
_whisperx.align = lambda *_a, **_k: {"segments": []}
sys.modules.setdefault("whisperx", _whisperx)
