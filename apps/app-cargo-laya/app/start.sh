#!/bin/sh

# Cargo entrypoint: serves the Laya "System 1" decision model
# (https://huggingface.co/convaiinnovations/laya) over the Acurast reverse
# tunnel. PRIMARY (Let's Encrypt) forwards the Laya HTTP API
# (`POST /v1/systemone`, TypeSafe Jev-compatible), SECONDARY (self-signed)
# forwards dropbear SSH for debugging.
#
# Runs on the Acurast ONNX base image (images/onnx: Alpine + Python + ONNX
# Runtime + tokenizers + openssl + dropbear + curl), so nothing is installed here.
# Phase 1 brings up SSH + the tunnel, phase 2 downloads the model (~630 MB,
# once per deployment) and starts the server. If phase 2 fails you can still
# SSH in and debug it live.

echo "=== Setting up environment ==="
export HOME=/root
# The processor leaves TMPDIR pointing at the Android app dir, which doesn't
# exist inside the proot rootfs.
export TMPDIR="$HOME/tmp"
mkdir -p "$TMPDIR"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_PORT="${WEB_PORT:-8080}"
# The rootfs survives restarts within the same deployment (the processor keys
# it by deployment), so the model downloads once.
MODEL_DIR=/root/laya-model
MODEL_URL="${LAYA_MODEL_URL:-https://huggingface.co/acurast/laya-english-onnx-int8/resolve/main}"

DROPBEAR_PID=""
TUNNEL_PID=""
LAYA_PID=""

. "$SCRIPT_DIR/callback.sh"

finish() {
    code=$?
    [ -n "$DROPBEAR_PID" ] && kill "$DROPBEAR_PID" 2>/dev/null || true
    [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
    [ -n "$LAYA_PID" ] && kill "$LAYA_PID" 2>/dev/null || true
    exit "$code"
}
trap finish INT TERM EXIT

# The tunnel is public: never serve the model without a bearer token.
if [ -z "$LAYA_API_KEY" ]; then
    report_error "LAYA_API_KEY not set — refusing to expose the model without auth"
    exit 1
fi
if ! python3 -c "import onnxruntime, tokenizers" 2>/dev/null; then
    report_error "onnxruntime/tokenizers missing — deploy with the Acurast ONNX base image (see acurast.json)"
    exit 1
fi

# =========================================================================
# Phase 1 — SSH + tunnel.
# =========================================================================
send_log "Phase 1: SSH + tunnel"

mkdir -p /etc/profile.d
env | sed 's/^/export /' > /etc/profile.d/acurast-env.sh

echo "root:${SSH_PASSWORD:-password}" | chpasswd
mkdir -p /etc/dropbear
send_log "Starting SSH (dropbear) on 127.0.0.1:2222"
dropbear -F -E -p 127.0.0.1:2222 -R &
DROPBEAR_PID=$!

send_log "SSH up, starting Acurast reverse tunnel"
python3 "$SCRIPT_DIR/tunnel.py" &
TUNNEL_PID=$!

# =========================================================================
# Phase 2 — model + server. Failures keep SSH + tunnel alive.
# =========================================================================
fail_keep_alive() {
    report_error "$1 — SSH in over the secondary tunnel to debug; SSH + tunnel left running."
    wait "$TUNNEL_PID"
    exit 1
}

# Laya's English checkpoint as one ONNX graph with 8-bit weights, built by
# tools/export_model.py. Pinned by sha256; -c resumes an interrupted download.
fetch() {
    [ -f "$MODEL_DIR/$2" ] && return 0
    mkdir -p "$(dirname "$MODEL_DIR/$2")"
    wget -q -c -T 60 -O "$MODEL_DIR/$2.part" "$MODEL_URL/$2" || return 1
    echo "$1  $MODEL_DIR/$2.part" | sha256sum -c -s || { rm -f "$MODEL_DIR/$2.part"; return 1; }
    mv "$MODEL_DIR/$2.part" "$MODEL_DIR/$2"
}
send_log "Phase 2: fetching the model (~630 MB on first run)"
fetch ae287b56bbcf5f8c4f4541ae9dfd00c914c4c48b940b8398c3058af37ba92bbd rl_agent_config.json \
    && fetch 6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30 tokenizer/tokenizer.json \
    && fetch ef58640e77f8ca8564302951faa29367d90373f50759fbdbf82787ce4f8dad97 laya.onnx \
    && fetch 9dd4023acab4e01a333b6bc6e7dfea5fc34c193d6490f0e130c3ec395e229b85 laya.onnx.data \
    || fail_keep_alive "model download failed or checksum mismatch"

send_log "Phase 2: starting the server"
LAYA_HOST=127.0.0.1 LAYA_PORT="$WEB_PORT" LAYA_MODEL_DIR="$MODEL_DIR" \
    python3 "$SCRIPT_DIR/serve.py" &
LAYA_PID=$!

i=0
until wget -q -O /dev/null "http://127.0.0.1:$WEB_PORT/health" 2>/dev/null; do
    kill -0 "$LAYA_PID" 2>/dev/null || fail_keep_alive "laya server exited during startup"
    i=$((i + 1))
    [ "$i" -gt 120 ] && fail_keep_alive "laya server not healthy after 10 min"
    sleep 5
done
send_callback "{\"event\":\"ready\",\"health\":$(wget -q -O - "http://127.0.0.1:$WEB_PORT/health")}"

# Block on the tunnel; if it dies, tear everything down.
wait "$TUNNEL_PID"
TUNNEL_EXIT=$?
if [ "$TUNNEL_EXIT" -ne 0 ]; then
    report_error "tunnel exited with status $TUNNEL_EXIT"
    exit "$TUNNEL_EXIT"
fi
wait "$LAYA_PID"
