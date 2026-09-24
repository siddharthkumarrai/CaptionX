"""Print the resolved hardware profile + CUDA availability inside a worker."""
import sys

sys.path.insert(0, "/app")

import torch  # noqa: E402

print("torch", torch.__version__, "cuda_build", torch.version.cuda)
print("cuda_available", torch.cuda.is_available())
print("device_count", torch.cuda.device_count())
if torch.cuda.is_available():
    print("device_name", torch.cuda.get_device_name(0))

from app.services.hardware import detect_hardware  # noqa: E402
from app.core.config import settings  # noqa: E402

print("settings.WHISPER_MODEL =", settings.WHISPER_MODEL)
print("profile =", detect_hardware())
