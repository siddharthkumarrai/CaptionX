"""
app/services/hardware.py
========================
Production hardware auto-detection for the transcription backend.

Detects CPU cores, RAM, and GPU (via torch) to choose an optimal device,
compute type, thread count, and batch size — with NO third-party
dependencies (stdlib + torch only). No NVIDIA driver is required: AMD
ROCm-enabled torch builds also report CUDA, while everything else falls
back to CPU.
"""
import os
import re
import torch
from app.core.config import settings


def _logical_cpus() -> int:
    try:
        return os.cpu_count() or 1
    except Exception:
        return 1


def _physical_cpus() -> int:
    """Best-effort physical-core count via /proc/cpuinfo (Linux)."""
    try:
        cores_per_socket = 1
        siblings = 1
        with open("/proc/cpuinfo", "r") as f:
            for line in f:
                line = line.strip().lower()
                if not line or ":" not in line:
                    continue
                key, val = line.split(":", 1)
                key = key.strip()
                val = val.strip()
                if key == "cpu cores":
                    cores_per_socket = int(val or 1)
                elif key == "siblings":
                    siblings = int(val or 1)
        if cores_per_socket > 0:
            return cores_per_socket
    except Exception:
        pass
    return _logical_cpus()


def _meminfo_gb() -> float:
    try:
        with open("/proc/meminfo", "r") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) / (1024 * 1024)
    except Exception:
        pass
    return 0.0


def _cpu_model() -> str:
    try:
        with open("/proc/cpuinfo", "r") as f:
            for line in f:
                if line.lower().startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except Exception:
        pass
    return "unknown"


class HardwareProfile:
    """Resolved runtime profile for the host this worker runs on."""

    __slots__ = (
        "device", "compute_type", "threads", "batch_size",
        "logical_cpus", "physical_cpus", "ram_gb", "cpu_model",
        "cuda_available", "gpu_name",
    )

    def __init__(self):
        self.logical_cpus = _logical_cpus()
        self.physical_cpus = _physical_cpus()
        self.ram_gb = _meminfo_gb()
        self.cpu_model = _cpu_model()
        self.cuda_available = torch.cuda.is_available()
        self.gpu_name = torch.cuda.get_device_name(0) if self.cuda_available else ""

        req = settings.WHISPER_DEVICE.lower()
        if req == "cuda":
            if not self.cuda_available:
                raise RuntimeError("cuda requested but no CUDA device is available")
            self.device = "cuda"
        elif req == "cpu":
            self.device = "cpu"
        else:  # auto
            self.device = "cuda" if self.cuda_available else "cpu"

        if self.device == "cuda":
            self.threads = None
            self.batch_size = 16
            self.compute_type = "float16"
        else:
            self.threads = max(1, min(self.physical_cpus, self.logical_cpus, 8))
            if self.ram_gb >= 16:
                self.batch_size = 32
            elif self.ram_gb >= 8:
                self.batch_size = 16
            else:
                self.batch_size = 8
            req_compute = settings.WHISPER_COMPUTE_TYPE.lower()
            self.compute_type = "int8" if req_compute == "auto" else settings.WHISPER_COMPUTE_TYPE

    def __repr__(self) -> str:
        return (
            f"HardwareProfile(device={self.device!r}, compute={self.compute_type!r}, "
            f"threads={self.threads}, batch={self.batch_size}, "
            f"cpus={self.logical_cpus}{'phys/' + str(self.physical_cpus) or ''}, "
            f"ram_gb={self.ram_gb:.1f}, cuda={self.cuda_available}, "
            f"gpu={self.gpu_name or self.cpu_model})"
        )


def detect_hardware() -> HardwareProfile:
    return HardwareProfile()
