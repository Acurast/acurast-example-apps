#!/bin/sh

# Cargo entrypoint: serves the Laya "System 1" decision model
# (https://huggingface.co/convaiinnovations/laya) over the Acurast reverse
# tunnel. PRIMARY (Let's Encrypt) forwards the Laya HTTP API
# (`POST /v1/systemone`, TypeSafe Jev-compatible), SECONDARY (self-signed)
# forwards dropbear SSH for debugging.
#
# Runs on the Acurast ONNX base image (images/onnx: Alpine + Python + ONNX
# Runtime + tokenizers + openssl + dropbear + curl), so nothing is installed here.
# Phase 1 brings up SSH + the tunnel, phase 2 starts the server, which downloads
# the model (~630 MB, once per deployment) while the demo pages show the
# progress. If phase 2 fails you can still SSH in and debug it live.

echo "=== Setting up environment ==="
export HOME=/root
# The processor leaves TMPDIR pointing at the Android app dir, which doesn't
# exist inside the proot rootfs.
export TMPDIR="$HOME/tmp"
mkdir -p "$TMPDIR"

# Some processors (seen on 1.27.1) leave /etc/resolv.conf empty: no DNS at all
# ("[Errno -3] Try again"), while the network itself works.
if ! grep -q '^nameserver' /etc/resolv.conf 2>/dev/null; then
    printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\nnameserver 8.8.4.4\n' > /etc/resolv.conf
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_PORT="${WEB_PORT:-8080}"
# The rootfs survives restarts within the same deployment (the processor keys
# it by deployment), so the model downloads once.
MODEL_DIR=/root/laya-model

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

# The server downloads the model itself (~630 MB, sha256-pinned in serve.py, once per
# deployment) and shows the progress on the demo pages, so it starts right away.
send_log "Phase 2: starting the server; it downloads the model (~630 MB on first run)"
LAYA_HOST=127.0.0.1 LAYA_PORT="$WEB_PORT" LAYA_MODEL_DIR="$MODEL_DIR" \
    python3 "$SCRIPT_DIR/serve.py" &
LAYA_PID=$!

i=0
until wget -q -O - "http://127.0.0.1:$WEB_PORT/health" 2>/dev/null | grep -q '"status": "ok"'; do
    kill -0 "$LAYA_PID" 2>/dev/null || fail_keep_alive "laya server exited during startup"
    if wget -q -O - "http://127.0.0.1:$WEB_PORT/health" 2>/dev/null | grep -q '"status": "error"'; then
        fail_keep_alive "model download or load failed: $(wget -q -O - "http://127.0.0.1:$WEB_PORT/health")"
    fi
    i=$((i + 1))
    [ "$i" -gt 720 ] && fail_keep_alive "laya server not ready after 60 min"
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
