#!/bin/sh

# Cargo entrypoint: serves the Laya "System 1" decision model
# (https://huggingface.co/convaiinnovations/laya) over the Acurast reverse
# tunnel. PRIMARY (Let's Encrypt) forwards the Laya HTTP API
# (`POST /v1/systemone`, TypeSafe Jev-compatible), SECONDARY (self-signed)
# forwards dropbear SSH for debugging.
#
# Two phases on purpose: phase 1 brings up SSH + the tunnel fast, phase 2 does
# the heavy PyTorch install and model download (~1 GB). If phase 2 fails you can
# still SSH in and debug it live.

echo "=== Setting up environment ==="
export HOME=/root
export DEBIAN_FRONTEND=noninteractive
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod +x /usr/sbin/policy-rc.d

# The processor leaves TMPDIR pointing at the Android app dir, which doesn't
# exist inside the proot rootfs; pip needs a real writable one.
export TMPDIR="$HOME/tmp"
mkdir -p "$TMPDIR"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GETIFADDRS_OVERRIDE_SO=/usr/local/lib/libgetifaddrs_override.so
VENV=/opt/laya
WEB_PORT="${WEB_PORT:-8080}"

DROPBEAR_PID=""
TUNNEL_PID=""
LAYA_PID=""

# The rootfs survives restarts within the same deployment (the processor keys
# it by deployment), so every install step below is skipped when already done.
APT_DEPS="curl dropbear gcc libc6-dev python3 python3-venv python3-cryptography ca-certificates"
if ! dpkg -s $APT_DEPS >/dev/null 2>&1; then
    apt-get update
    apt-get install -y $APT_DEPS
fi

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

# =========================================================================
# Phase 1 — SSH + tunnel.
# =========================================================================
send_log "Phase 1: SSH + tunnel"

# --- getifaddrs shim (PRoot has no real interfaces; fake a loopback) ---
if [ ! -f "$GETIFADDRS_OVERRIDE_SO" ]; then
    mkdir -p "$(dirname "$GETIFADDRS_OVERRIDE_SO")"
    gcc -shared -fPIC -o "$GETIFADDRS_OVERRIDE_SO" "$SCRIPT_DIR/getifaddrs_override.c"
fi
export LD_PRELOAD="$GETIFADDRS_OVERRIDE_SO"

mkdir -p /etc/profile.d
echo "export LD_PRELOAD=$GETIFADDRS_OVERRIDE_SO" > /etc/profile.d/ifaddrs-shim.sh
env | sed 's/^/export /' > /etc/profile.d/acurast-env.sh

echo "root:${SSH_PASSWORD:-password}" | chpasswd
mkdir -p /etc/dropbear
dropbearkey -t rsa -f /etc/dropbear/dropbear_rsa_host_key 2>/dev/null || true
dropbearkey -t ecdsa -f /etc/dropbear/dropbear_ecdsa_host_key 2>/dev/null || true

send_log "Starting SSH (dropbear) on 127.0.0.1:2222"
dropbear -F -E -p 2222 -R &
DROPBEAR_PID=$!

send_log "SSH up, starting Acurast reverse tunnel"
python3 "$SCRIPT_DIR/tunnel.py" &
TUNNEL_PID=$!

# =========================================================================
# Phase 2 — PyTorch (CPU) + Laya. Failures keep SSH + tunnel alive.
# =========================================================================
fail_keep_alive() {
    report_error "$1 — SSH in over the secondary tunnel to debug; SSH + tunnel left running."
    wait "$TUNNEL_PID"
    exit 1
}

if [ ! -x "$VENV/bin/python" ]; then
    python3 -m venv "$VENV" || fail_keep_alive "venv creation failed"
fi
if "$VENV/bin/python" -c "import torch, laya.serve, fastapi, uvicorn" 2>/dev/null; then
    send_log "Phase 2: PyTorch + laya already installed, skipping"
else
    send_log "Phase 2: installing PyTorch (CPU), ~5 min"
    # CPU index: the default PyPI aarch64 torch wheel pulls in CUDA packages.
    "$VENV/bin/pip" install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
        || fail_keep_alive "torch install failed"
    send_log "Phase 2: installing laya"
    "$VENV/bin/pip" install --no-cache-dir "laya[serve]>=0.3.9,<0.4" \
        || fail_keep_alive "laya install failed"
fi

# Only the English checkpoint (~800 MB): the other two would triple RAM. The
# Hugging Face cache (/root/.cache/huggingface) survives restarts, so this only
# downloads once per deployment. LAYA_THREADS is left to torch's default: on a
# Snapdragon 855, 1 to 7 threads measured within ~15% of each other.
send_log "Loading the model (downloads ~800 MB on first run)"
LAYA_HOST=127.0.0.1 LAYA_PORT="$WEB_PORT" LAYA_MODELS="${LAYA_MODELS:-english}" \
    "$VENV/bin/python" "$SCRIPT_DIR/serve.py" &
LAYA_PID=$!

i=0
until curl -sf "http://127.0.0.1:$WEB_PORT/health" >/dev/null; do
    kill -0 "$LAYA_PID" 2>/dev/null || fail_keep_alive "laya server exited during startup"
    i=$((i + 1))
    [ "$i" -gt 360 ] && fail_keep_alive "laya server not healthy after 30 min"
    sleep 5
done
send_callback "{\"event\":\"ready\",\"health\":$(curl -s "http://127.0.0.1:$WEB_PORT/health")}"

# Block on the tunnel; if it dies, tear everything down.
wait "$TUNNEL_PID"
TUNNEL_EXIT=$?
if [ "$TUNNEL_EXIT" -ne 0 ]; then
    report_error "tunnel exited with status $TUNNEL_EXIT"
    exit "$TUNNEL_EXIT"
fi
wait "$LAYA_PID"
