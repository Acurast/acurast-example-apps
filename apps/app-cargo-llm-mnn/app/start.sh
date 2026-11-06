#!/bin/sh

# Cargo entrypoint: serves Qwen3.5 with MNN (https://github.com/alibaba/MNN) as an
# OpenAI-compatible API over the Acurast reverse tunnel. PRIMARY (Let's Encrypt)
# forwards the API (server.py on 127.0.0.1:8080), SECONDARY (self-signed) forwards
# dropbear SSH for debugging, started only when SSH_PASSWORD is set.
#
# Runs on the proot-distro Ubuntu rootfs (glibc: the MNN wheels are manylinux).
# Phase 1 installs the few packages the tunnel needs and opens it. Phase 2 installs
# MNN into a venv and starts server.py, which downloads the model (once per
# deployment) while GET /info shows the progress. If phase 2 fails, the tunnel
# (and SSH, if enabled) stay up so you can debug.

echo "=== Setting up environment ==="
export HOME=/root
# The processor leaves TMPDIR pointing at the Android app dir, which doesn't
# exist inside the proot rootfs (pip needs it).
export TMPDIR="$HOME/tmp"
mkdir -p "$TMPDIR"
# No debconf prompts (no stdin), and no service starts from package scripts
# (there is no init system in the proot rootfs).
export DEBIAN_FRONTEND=noninteractive
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod +x /usr/sbin/policy-rc.d

# Some processors (seen on 1.27.1) leave /etc/resolv.conf empty: no DNS at all,
# while the network itself works.
if ! grep -q '^nameserver' /etc/resolv.conf 2>/dev/null; then
    printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\nnameserver 8.8.4.4\n' > /etc/resolv.conf
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export WEB_PORT="${WEB_PORT:-8080}"
# The rootfs survives restarts within the same deployment, so the venv and the
# model are set up once.
VENV=/opt/mnnpy
MNN_VERSION=3.6.2

DROPBEAR_PID=""
TUNNEL_PID=""
SERVER_PID=""

. "$SCRIPT_DIR/callback.sh"

finish() {
    code=$?
    [ -n "$DROPBEAR_PID" ] && kill "$DROPBEAR_PID" 2>/dev/null || true
    [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
    exit "$code"
}
trap finish INT TERM EXIT

# =========================================================================
# Phase 1 — tunnel (+ SSH when SSH_PASSWORD is set).
# =========================================================================
PKGS="python3-venv openssl curl ca-certificates"
[ -n "$SSH_PASSWORD" ] && PKGS="$PKGS dropbear"
apt-get update && apt-get install -y $PKGS || { echo "apt-get install failed"; exit 1; }

# The tunnel is public: never serve the model without a bearer token. (Checked after
# apt-get, because callback.sh needs curl.)
if [ -z "$LLM_API_KEY" ]; then
    echo "LLM_API_KEY not set, refusing to expose the model without auth"
    report_error "LLM_API_KEY not set — refusing to expose the model without auth"
    exit 1
fi
send_log "Phase 1: tunnel"

if [ -n "$SSH_PASSWORD" ]; then
    mkdir -p /etc/profile.d /etc/dropbear
    env | grep -E '^(LLM_|MODEL_DIR|WEB_PORT)' | sed 's/^/export /' > /etc/profile.d/acurast-env.sh
    echo "root:$SSH_PASSWORD" | chpasswd
    send_log "Starting SSH (dropbear) on 127.0.0.1:2222"
    dropbear -F -E -p 127.0.0.1:2222 -R &
    DROPBEAR_PID=$!
fi

python3 "$SCRIPT_DIR/tunnel.py" &
TUNNEL_PID=$!

# =========================================================================
# Phase 2 — MNN + model + server. Failures keep the tunnel (and SSH) alive.
# =========================================================================
fail_keep_alive() {
    echo "ERROR: $1"
    report_error "$1 — tunnel left running (SSH in over the secondary tunnel if SSH_PASSWORD is set)."
    wait "$TUNNEL_PID"
    exit 1
}

if ! "$VENV/bin/python" -c "import MNN.llm" 2>/dev/null; then
    send_log "Phase 2: installing MNN $MNN_VERSION"
    python3 -m venv "$VENV" && "$VENV/bin/pip" install --no-cache-dir "MNN==$MNN_VERSION" \
        || fail_keep_alive "pip install MNN failed"
fi

send_log "Phase 2: starting the server; it downloads ${LLM_MODEL:-4B} on the first run (GET /info shows progress)"
"$VENV/bin/python" "$SCRIPT_DIR/server.py" &
SERVER_PID=$!

while :; do
    HEALTH=$(curl -s "http://127.0.0.1:$WEB_PORT/health")
    case "$HEALTH" in
        *'"status": "ok"'*) break ;;
        *'"status": "error"'*) fail_keep_alive "model download or load failed, see GET /info" ;;
    esac
    kill -0 "$SERVER_PID" 2>/dev/null || fail_keep_alive "server exited during startup"
    sleep 5
done
send_callback "{\"event\":\"ready\",\"info\":$(curl -s "http://127.0.0.1:$WEB_PORT/info")}"

# Restart the server if it dies (e.g. the phone's low-memory killer): the model is on
# disk, so it is back in seconds. Runs for as long as the tunnel does.
while kill -0 "$TUNNEL_PID" 2>/dev/null; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        report_error "server exited, restarting it"
        "$VENV/bin/python" "$SCRIPT_DIR/server.py" &
        SERVER_PID=$!
    fi
    sleep 10
done
wait "$TUNNEL_PID"
TUNNEL_EXIT=$?
report_error "tunnel exited with status $TUNNEL_EXIT"
exit "$TUNNEL_EXIT"
