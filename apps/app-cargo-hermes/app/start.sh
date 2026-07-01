#!/bin/sh
set -e

# Cargo entrypoint: runs the Hermes AI agent (https://hermes-agent.org, by Nous
# Research) on the processor, exposed two ways over the Acurast reverse tunnel:
#   - PRIMARY connection -> Hermes WebUI (HTTP on 8787). Open the tunnel URL in a
#     browser for the full chat/sessions/workspace UI.
#   - SECONDARY connection -> SSH (dropbear on 2222). SSH in for the `hermes` CLI
#     or to debug.
#
# Setup is split into two phases on purpose: phase 1 installs the minimal deps,
# brings up SSH, and starts the tunnel FIRST, so if the heavier Hermes + WebUI
# install in phase 2 stalls or fails you can still SSH in (secondary) to debug.

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
WEBUI_PORT=8787
WEBUI_DIR="$HOME/hermes-webui"
HERMES_INSTALL_URL="https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh"
WEBUI_REPO="https://github.com/nesquena/hermes-webui.git"
# OpenRouter model Hermes uses. Override via the HERMES_MODEL deployment env var.
HERMES_MODEL="${HERMES_MODEL:-openai/gpt-4o-mini}"

DROPBEAR_PID=""
TUNNEL_PID=""
WEBUI_PID=""
GATEWAY_PID=""

apt-get update
if ! command -v curl >/dev/null 2>&1; then apt-get install -y curl; fi

. "$SCRIPT_DIR/callback.sh"

finish() {
    code=$?
    [ -n "$DROPBEAR_PID" ] && kill "$DROPBEAR_PID" 2>/dev/null || true
    [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
    [ -n "$WEBUI_PID" ] && kill "$WEBUI_PID" 2>/dev/null || true
    [ -n "$GATEWAY_PID" ] && kill "$GATEWAY_PID" 2>/dev/null || true
    if [ "$code" -ne 0 ]; then
        echo "ERROR: start.sh exiting with code $code"
        report_error "start.sh exited with code $code"
    fi
    exit "$code"
}
trap finish EXIT INT TERM

# =========================================================================
# Phase 1 — minimal deps, SSH, and the tunnel. Keep this fast and reliable so
# the deployment is reachable (via the secondary SSH connection) before the
# heavy install runs.
# =========================================================================
send_log "Phase 1: installing SSH + tunnel deps (dropbear, python3, git, build tools)"
# git + build tools: the Hermes installer fetches the repo and manages its own
# Python 3.11 via uv; the WebUI is cloned with git and runs on system python3.
apt-get install -y dropbear gcc libc6-dev python3 python3-venv python3-cryptography \
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
env | grep -E '^(OPENROUTER_API_KEY|HERMES_MODEL|HERMES_WEBUI_PASSWORD|CALLBACK_URL|DOMAIN_SUFFIX)=' \
    | sed 's/^/export /' > /etc/profile.d/acurast-env.sh
# HERMES_MODEL may come from the deployment env or fall back to the default above;
# make sure the interactive SSH session and cron see the resolved value.
echo "export HERMES_MODEL=$HERMES_MODEL" >> /etc/profile.d/acurast-env.sh

cat > /etc/motd <<MOTD

  Hermes agent on Acurast.

  WebUI: open the PRIMARY tunnel URL in your browser (HTTP on :${WEBUI_PORT}).
  CLI:   you are in the SSH (secondary) session — run:

      hermes

  Hermes is configured to use OpenRouter (model: ${HERMES_MODEL}).
  OPENROUTER_API_KEY is already exported from your deployment env.
  (If \`hermes\` is not found yet, the phase-2 install is still running — wait a bit.)

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
# Phase 2 — Hermes (uv + Python 3.11) then the Hermes WebUI. Any failure (or
# hang) must NOT tear down SSH + the tunnel, so you can always SSH in (secondary)
# to inspect. fail_keep_alive reports the problem then blocks on the tunnel.
# =========================================================================
set +e

fail_keep_alive() {
    report_error "$1 — SSH in (secondary connection) to debug; SSH + tunnel left running."
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

# --- Point Hermes at OpenRouter (we skip the interactive setup wizard, so pin
# the provider + model non-interactively; the key comes from OPENROUTER_API_KEY
# in the process env). ---
send_log "Configuring Hermes provider=openrouter model=$HERMES_MODEL"
hermes config set model.provider openrouter || fail_keep_alive "hermes config set model.provider failed"
hermes config set model.model "$HERMES_MODEL" || fail_keep_alive "hermes config set model.model failed"

# --- Hermes WebUI (vanilla-JS front end + python server; reuses the Hermes
# agent + models above, no extra config). bootstrap.py creates its own venv. ---
if [ ! -d "$WEBUI_DIR" ]; then
    send_log "Phase 2: cloning Hermes WebUI"
    git clone --depth 1 "$WEBUI_REPO" "$WEBUI_DIR" || fail_keep_alive "Hermes WebUI clone failed"
fi

# --- WebUI auth (CRITICAL) ---
# The WebUI binds loopback and the tunnel forwards FROM loopback, so the server
# treats every request as local and does NOT auto-require auth — but the primary
# tunnel URL is public. Without a password it is an open, unauthenticated agent
# that can run commands. If none was provided, generate a strong one and report
# it via CALLBACK_URL so the URL is never left unprotected.
if [ -z "$HERMES_WEBUI_PASSWORD" ]; then
    HERMES_WEBUI_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')"
    export HERMES_WEBUI_PASSWORD
    echo "export HERMES_WEBUI_PASSWORD=$HERMES_WEBUI_PASSWORD" >> /etc/profile.d/acurast-env.sh
    send_callback "{\"event\":\"webui_password\",\"password\":\"${HERMES_WEBUI_PASSWORD}\"}"
    send_log "HERMES_WEBUI_PASSWORD was not set — generated one (sent as the webui_password callback event). Use it to log into the WebUI."
fi

send_log "Phase 2: starting Hermes WebUI on 127.0.0.1:${WEBUI_PORT}"
# Bind loopback only — the tunnel's PRIMARY connection forwards here.
# SKIP_ONBOARDING bypasses the interactive first-run wizard (we are headless).
# HERMES_WEBUI_PASSWORD (provided or generated above) protects the public URL.
HERMES_WEBUI_HOST=127.0.0.1 \
HERMES_WEBUI_PORT="$WEBUI_PORT" \
HERMES_WEBUI_SKIP_ONBOARDING=1 \
    python3 "$WEBUI_DIR/bootstrap.py" --no-browser "$WEBUI_PORT" \
    >/tmp/hermes-webui.log 2>&1 &
WEBUI_PID=$!

# --- Hermes gateway (cron scheduler). The WebUI runs the agent in-process for
# interactive chat, but SCHEDULED jobs only tick when the gateway daemon is
# running. `hermes gateway` runs in the foreground (the `start` subcommand needs
# systemd/launchd, absent in proot), so background it. No messaging tokens are
# required for cron-only operation; set platform tokens (TELEGRAM_*, etc.) to
# also bridge chat. Shares $HERMES_HOME with the WebUI, so jobs created in the
# UI are picked up here. ---
send_log "Phase 2: starting Hermes gateway (cron scheduler)"
hermes gateway >/tmp/hermes-gateway.log 2>&1 &
GATEWAY_PID=$!

send_log "Hermes ready — open the primary tunnel URL in a browser, or SSH in and run: hermes"

# Block on the tunnel; if it dies, tear everything down.
TUNNEL_EXIT=0
wait "$TUNNEL_PID" || TUNNEL_EXIT=$?
if [ "$TUNNEL_EXIT" -ne 0 ]; then
    report_error "tunnel exited with status $TUNNEL_EXIT"
    exit "$TUNNEL_EXIT"
fi

wait "$DROPBEAR_PID"
