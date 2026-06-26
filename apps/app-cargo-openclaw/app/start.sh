#!/bin/sh
set -e

# Cargo entrypoint: runs the OpenClaw AI assistant (https://openclaw.ai) on the
# processor, reachable over SSH via the Acurast reverse tunnel. SSH in, then run
# `openclaw onboard` to set it up.
#
# Setup is split into two phases on purpose: phase 1 installs the minimal deps,
# brings up SSH, and starts the tunnel FIRST, so if the heavier Node.js/OpenClaw
# install in phase 2 stalls or fails you can still SSH into the machine to debug.

echo "=== Setting up environment ==="
export HOME=/root
# Never block on debconf prompts (no stdin here), and stop package postinst
# scripts from trying to start services via systemd/invoke-rc.d — there is no
# init system in the proot rootfs, and those attempts hang or fail.
export DEBIAN_FRONTEND=noninteractive
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod +x /usr/sbin/policy-rc.d

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GETIFADDRS_OVERRIDE_SO=/usr/local/lib/libgetifaddrs_override.so
NODE_VERSION=v24.16.0
NODE_DIST="node-${NODE_VERSION}-linux-arm64"
NODE_DIR="/usr/local/lib/nodejs/${NODE_DIST}"
SSH_PORT=2222

DROPBEAR_PID=""
TUNNEL_PID=""

apt-get update
if ! command -v curl >/dev/null 2>&1; then apt-get install -y curl; fi

. "$SCRIPT_DIR/callback.sh"

finish() {
    code=$?
    [ -n "$DROPBEAR_PID" ] && kill "$DROPBEAR_PID" 2>/dev/null || true
    [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
    if [ "$code" -ne 0 ]; then
        echo "ERROR: start.sh exiting with code $code"
        report_error "start.sh exited with code $code"
    fi
    exit "$code"
}
trap finish EXIT INT TERM

# =========================================================================
# Phase 1 — minimal deps, SSH, and the tunnel. Keep this fast and reliable so
# the deployment is reachable before the heavy install runs.
# =========================================================================
send_log "Phase 1: installing SSH + tunnel deps (dropbear, python3, build tools)"
apt-get install -y dropbear gcc libc6-dev python3 python3-cryptography xz-utils ca-certificates

# --- getifaddrs shim (PRoot has no real interfaces; fake a loopback) ---
if [ ! -f "$GETIFADDRS_OVERRIDE_SO" ]; then
    mkdir -p "$(dirname "$GETIFADDRS_OVERRIDE_SO")"
    gcc -shared -fPIC -o "$GETIFADDRS_OVERRIDE_SO" "$SCRIPT_DIR/getifaddrs_override.c"
fi
export LD_PRELOAD="$GETIFADDRS_OVERRIDE_SO"

# --- Make the toolchain + secrets available to the interactive SSH session ---
# (Written now, before the install finishes; the Node PATH resolves once phase 2
# drops the binaries in place.)
mkdir -p /etc/profile.d
echo "export LD_PRELOAD=$GETIFADDRS_OVERRIDE_SO" > /etc/profile.d/ifaddrs-shim.sh
echo "export PATH=${NODE_DIR}/bin:\$PATH" > /etc/profile.d/nodejs.sh
env | grep -E '^(ANTHROPIC_API_KEY|OPENAI_API_KEY|CALLBACK_URL|DOMAIN_SUFFIX)=' \
    | sed 's/^/export /' > /etc/profile.d/acurast-env.sh

cat > /etc/motd <<'MOTD'

  OpenClaw on Acurast. To set up:

      openclaw onboard

  Your LLM API key is already exported from your deployment env.
  (If `openclaw` is not found yet, phase-2 install is still running — wait a bit.)

MOTD

# --- SSH (dropbear) ---
echo "root:${SSH_PASSWORD:-password}" | chpasswd
mkdir -p /etc/dropbear
dropbearkey -t rsa -f /etc/dropbear/dropbear_rsa_host_key 2>/dev/null || true
dropbearkey -t ecdsa -f /etc/dropbear/dropbear_ecdsa_host_key 2>/dev/null || true

send_log "Starting SSH (dropbear) on 127.0.0.1:${SSH_PORT}"
dropbear -F -E -p "$SSH_PORT" -R &
DROPBEAR_PID=$!

send_log "SSH up, starting Acurast reverse tunnel"
python3 "$SCRIPT_DIR/tunnel.py" &
TUNNEL_PID=$!

# =========================================================================
# Phase 2 — Node.js + OpenClaw. Any failure (or hang) must NOT tear down SSH +
# the tunnel, so you can always SSH in to inspect. fail_keep_alive reports the
# problem then blocks on the tunnel.
# =========================================================================
set +e

fail_keep_alive() {
    report_error "$1 — SSH in to debug; SSH + tunnel left running."
    send_log "Phase 2 failed; keeping SSH + tunnel alive for debugging"
    wait "$TUNNEL_PID"
    exit 1
}

# --- Node.js (prebuilt arm64 tarball; matches the processor arch) ---
if [ ! -x "${NODE_DIR}/bin/node" ]; then
    send_log "Phase 2: installing Node.js ${NODE_VERSION}"
    mkdir -p /usr/local/lib/nodejs
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.xz" -o /tmp/node.tar.xz \
        || fail_keep_alive "Node.js download failed"
    tar -xf /tmp/node.tar.xz -C /usr/local/lib/nodejs || fail_keep_alive "Node.js extract failed"
    rm -f /tmp/node.tar.xz
fi
export PATH="${NODE_DIR}/bin:$PATH"

# --- OpenClaw CLI ---
if ! command -v openclaw >/dev/null 2>&1; then
    send_log "Phase 2: installing OpenClaw"
    npm install -g openclaw || fail_keep_alive "npm install -g openclaw failed"
fi

send_log "OpenClaw ready — SSH in and run: openclaw onboard"

# Block on the tunnel; if it dies, tear everything down.
TUNNEL_EXIT=0
wait "$TUNNEL_PID" || TUNNEL_EXIT=$?
if [ "$TUNNEL_EXIT" -ne 0 ]; then
    report_error "tunnel exited with status $TUNNEL_EXIT"
    exit "$TUNNEL_EXIT"
fi

wait "$DROPBEAR_PID"
