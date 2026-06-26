#!/bin/sh
set -e

# Cargo entrypoint: runs the Hermes AI agent (https://hermes-agent.org, by Nous
# Research) on the processor, reachable over SSH via the Acurast reverse tunnel.
# SSH in, then run `hermes`.
#
# Setup is split into two phases on purpose: phase 1 installs the minimal deps,
# brings up SSH, and starts the tunnel FIRST, so if the heavier Hermes install
# (uv + Python 3.11) in phase 2 stalls or fails you can still SSH in to debug.

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
SSH_PORT=2222
HERMES_INSTALL_URL="https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh"

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
send_log "Phase 1: installing SSH + tunnel deps (dropbear, python3, git, build tools)"
# git + build tools: the Hermes installer fetches the repo and manages its own
# Python 3.11 via uv (no system Python needed for Hermes itself).
apt-get install -y dropbear gcc libc6-dev python3 python3-cryptography \
    ca-certificates git xz-utils

# --- getifaddrs shim (PRoot has no real interfaces; fake a loopback) ---
if [ ! -f "$GETIFADDRS_OVERRIDE_SO" ]; then
    mkdir -p "$(dirname "$GETIFADDRS_OVERRIDE_SO")"
    gcc -shared -fPIC -o "$GETIFADDRS_OVERRIDE_SO" "$SCRIPT_DIR/getifaddrs_override.c"
fi
export LD_PRELOAD="$GETIFADDRS_OVERRIDE_SO"

# --- Make the toolchain + secrets available to the interactive SSH session ---
# (Written now, before the install finishes; the hermes PATH resolves once
# phase 2 drops the binaries under $HOME/.local.)
mkdir -p /etc/profile.d
echo "export LD_PRELOAD=$GETIFADDRS_OVERRIDE_SO" > /etc/profile.d/ifaddrs-shim.sh
echo "export PATH=\$HOME/.local/bin:\$PATH" > /etc/profile.d/hermes.sh
env | grep -E '^(OPENAI_API_KEY|CALLBACK_URL|DOMAIN_SUFFIX)=' \
    | sed 's/^/export /' > /etc/profile.d/acurast-env.sh

cat > /etc/motd <<'MOTD'

  Hermes agent on Acurast. To start:

      hermes

  OPENAI_API_KEY is already exported from your deployment env.
  (If `hermes` is not found yet, phase-2 install is still running — wait a bit.)

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
# Phase 2 — Hermes (uv + Python 3.11). Any failure (or hang) must NOT tear down
# SSH + the tunnel, so you can always SSH in to inspect. fail_keep_alive reports
# the problem then blocks on the tunnel.
# =========================================================================
set +e

fail_keep_alive() {
    report_error "$1 — SSH in to debug; SSH + tunnel left running."
    send_log "Phase 2 failed; keeping SSH + tunnel alive for debugging"
    wait "$TUNNEL_PID"
    exit 1
}

# --- Hermes (installs uv + Python 3.11 under $HOME/.local; no sudo) ---
export PATH="$HOME/.local/bin:$PATH"
if ! command -v hermes >/dev/null 2>&1; then
    send_log "Phase 2: installing Hermes (uv + Python 3.11)"
    curl -fsSL "$HERMES_INSTALL_URL" | bash || fail_keep_alive "Hermes installer failed"
fi

send_log "Hermes ready — SSH in and run: hermes"

# Block on the tunnel; if it dies, tear everything down.
TUNNEL_EXIT=0
wait "$TUNNEL_PID" || TUNNEL_EXIT=$?
if [ "$TUNNEL_EXIT" -ne 0 ]; then
    report_error "tunnel exited with status $TUNNEL_EXIT"
    exit "$TUNNEL_EXIT"
fi

wait "$DROPBEAR_PID"
