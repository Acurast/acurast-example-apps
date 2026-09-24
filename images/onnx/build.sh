#!/bin/sh
# Builds the Acurast ONNX base rootfs for Cargo (Shell runtime) jobs: Alpine +
# Python + ONNX Runtime + numpy + tokenizers, plus openssl, dropbear and curl for the
# tunnel and SSH. No model inside: apps download their weights at start, so one
# image serves every ONNX app and the processor caches it per sha256.
#
#   ./build.sh
#
# Needs Docker (arm64 natively, or with binfmt/QEMU). Writes out/<name>.tar.xz
# and prints its sha256 for acurast.json (image.url / image.sha256).
set -eu

ALPINE=3.24.2
NAME="acurast-onnx-alpine$ALPINE-aarch64"
OUT="$(cd "$(dirname "$0")" && pwd)/out"
mkdir -p "$OUT"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run --platform linux/arm64 --name "$NAME" "alpine:$ALPINE" sh -euc '
    apk add --no-cache python3 py3-onnxruntime py3-numpy py3-pip openssl dropbear curl
    # --no-deps: Tokenizer.from_file needs none of huggingface-hub, httpx and co.
    pip install --no-cache-dir --no-deps --break-system-packages --root-user-action=ignore "tokenizers>=0.22,<0.24"
    apk del py3-pip
    python3 -c "import onnxruntime, tokenizers, numpy; print(\"onnxruntime\", onnxruntime.__version__, \"tokenizers\", tokenizers.__version__)"
    # Relative, not Alpine'"'"'s absolute /bin/busybox: processors check for the shell on the Android
    # filesystem before starting proot, where an absolute link points outside the rootfs
    # ("No executable shell found.").
    ln -sf busybox /bin/sh
    find /usr/lib/python3* -name __pycache__ -prune -exec rm -rf {} +
    rm -rf /var/cache/apk/* /root/.cache
'

# One top-level directory, like the proot-distro images: the processor strips the first
# entry's directory name from every path. Repacked inside a container: macOS tar adds
# AppleDouble "._*" entries, and a "._<dir>" first entry left the rootfs one level down
# ("No executable shell found." on every processor).
docker export "$NAME" | docker run --rm -i --platform linux/arm64 "alpine:$ALPINE" sh -c "
    apk add -q --no-cache tar xz >/dev/null
    mkdir -p /r/$NAME && tar -x -C /r/$NAME 2>/dev/null; rm -f /r/$NAME/.dockerenv
    tar -c -C /r $NAME | xz -T0 -9" > "$OUT/$NAME.tar.xz"
docker rm "$NAME" >/dev/null
# What processors check: the first entry is the one top-level directory, bin/sh is there.
python3 - "$OUT/$NAME.tar.xz" "$NAME" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1]) as t:
    names = t.getnames()
assert names[0].rstrip("/") == sys.argv[2], f"first entry is {names[0]!r}, not the top-level directory"
assert not [n for n in names if n.split("/")[-1].startswith("._")], "AppleDouble ._ entries in the archive"
assert f"{sys.argv[2]}/bin/sh" in names, "no bin/sh"
print("rootfs layout ok:", len(names), "entries")
PY
ls -l "$OUT/$NAME.tar.xz"
shasum -a 256 "$OUT/$NAME.tar.xz"
