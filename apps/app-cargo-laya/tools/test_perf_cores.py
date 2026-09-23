"""python3 test_core_sets.py — checks which cores laya_onnx runs on, for known phone layouts."""
import builtins
import io
import re
import os
import sys
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))
sys.modules.update({m: mock.MagicMock() for m in ("numpy", "onnxruntime", "tokenizers")})
import laya_onnx  # noqa: E402

real_open = builtins.open


def perf_cores(speeds, allowed, file="cpu_capacity"):
    def fake_open(path, *a, **k):
        m = re.search(r"/cpu(\d+)/(.+)$", str(path))
        if m and m.group(1) and str(path).startswith("/sys/"):
            if m.group(2) != file:
                raise OSError("missing")
            return io.StringIO(str(speeds[int(m.group(1))]))
        return real_open(path, *a, **k)

    with mock.patch("os.sched_getaffinity", return_value=set(allowed), create=True), mock.patch("builtins.open", fake_open):
        return laya_onnx.perf_cores()


# Pixel 7a (Tensor G2), capacities read on the phone: 4x A55 158, 2x A78 763, 2x X1 1024.
assert perf_cores([158] * 4 + [763] * 2 + [1024] * 2, range(8)) == [4, 5, 6, 7]
# No cpu_capacity: max frequency instead. Snapdragon 855 as a Cargo job saw it (cores 0-4 and 6).
assert perf_cores([1785000] * 4 + [2419000] * 3 + [2841000], [0, 1, 2, 3, 4, 6], "cpufreq/cpuinfo_max_freq") == [4, 6]
# One cluster: nothing to leave out.
assert perf_cores([1024] * 4, range(4)) == [0, 1, 2, 3]
print("ok")
