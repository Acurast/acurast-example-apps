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
    find /usr/lib/python3* -name __pycache__ -prune -exec rm -rf {} +
    rm -rf /var/cache/apk/* /root/.cache
'

# One top-level directory, like the proot-distro images: the processor strips the
# first entry'"'"'s directory name from every path.
rm -rf "$OUT/rootfs" && mkdir -p "$OUT/rootfs/$NAME"
docker export "$NAME" | tar -x -C "$OUT/rootfs/$NAME" 2>/dev/null || true
docker rm "$NAME" >/dev/null
rm -f "$OUT/rootfs/$NAME/.dockerenv"
tar -C "$OUT/rootfs" -cf - "$NAME" | xz -T0 -9 > "$OUT/$NAME.tar.xz"
rm -rf "$OUT/rootfs"
ls -l "$OUT/$NAME.tar.xz"
shasum -a 256 "$OUT/$NAME.tar.xz"
