#!/bin/sh
set -e

# Cargo entrypoint: runs the OpenClaw AI assistant (https://openclaw.ai) on the
# processor, exposed two ways over the Acurast reverse tunnel:
#   - PRIMARY connection -> OpenClaw Control UI (HTTP on 18789). Open the tunnel
#     URL in a browser for the full chat / config / sessions dashboard.
#   - SECONDARY connection -> SSH (dropbear on 2222). SSH in for the `openclaw`
#     CLI or to debug.
#
# Setup is split into two phases on purpose: phase 1 installs the minimal deps,
# brings up SSH, and starts the tunnel FIRST, so if the heavier Node.js/OpenClaw
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
NODE_VERSION=v24.16.0
NODE_DIST="node-${NODE_VERSION}-linux-arm64"
NODE_DIR="/usr/local/lib/nodejs/${NODE_DIST}"
SSH_PORT=2222
# Port the OpenClaw Control UI (gateway) listens on; the tunnel's PRIMARY
# connection forwards here. Matches OpenClaw's own default (18789).
GATEWAY_PORT=18789
OPENCLAW_CONFIG_DIR="$HOME/.openclaw"
OPENCLAW_CONFIG="$OPENCLAW_CONFIG_DIR/openclaw.json"
# tunnel.py writes the public Control UI origin (https://<clientId>.<suffix>)
# here once the tunnel is up; phase 2 reads it into gateway.controlUi.allowedOrigins.
ORIGIN_FILE=/tmp/acurast-primary-origin
export PRIMARY_ORIGIN_FILE="$ORIGIN_FILE"
rm -f "$ORIGIN_FILE"
# OpenRouter sub-model OpenClaw uses (the openrouter/ prefix is added in the
# config). Override via the OPENCLAW_MODEL deployment env var.
OPENCLAW_MODEL="${OPENCLAW_MODEL:-openai/gpt-4o-mini}"

DROPBEAR_PID=""
TUNNEL_PID=""
GATEWAY_PID=""

apt-get update
if ! command -v curl >/dev/null 2>&1; then apt-get install -y curl; fi

. "$SCRIPT_DIR/callback.sh"

finish() {
    code=$?
    [ -n "$DROPBEAR_PID" ] && kill "$DROPBEAR_PID" 2>/dev/null || true
    [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
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
send_log "Phase 1: installing SSH + tunnel deps (dropbear, python3, build tools)"
apt-get install -y dropbear gcc libc6-dev python3 python3-cryptography xz-utils ca-certificates

# --- getifaddrs shim (PRoot has no real interfaces; fake a loopback) ---
if [ ! -f "$GETIFADDRS_OVERRIDE_SO" ]; then
    mkdir -p "$(dirname "$GETIFADDRS_OVERRIDE_SO")"
    gcc -shared -fPIC -o "$GETIFADDRS_OVERRIDE_SO" "$SCRIPT_DIR/getifaddrs_override.c"
fi
export LD_PRELOAD="$GETIFADDRS_OVERRIDE_SO"

# --- Make the toolchain + secrets available to the interactive SSH session ---
# (Written now, before the install finishes; the Node/openclaw PATH resolves
# once phase 2 drops the binaries in place.)
mkdir -p /etc/profile.d
echo "export LD_PRELOAD=$GETIFADDRS_OVERRIDE_SO" > /etc/profile.d/ifaddrs-shim.sh
echo "export PATH=${NODE_DIR}/bin:\$PATH" > /etc/profile.d/nodejs.sh
env | grep -E '^(OPENROUTER_API_KEY|OPENCLAW_GATEWAY_PASSWORD|CALLBACK_URL|DOMAIN_SUFFIX)=' \
    | sed 's/^/export /' > /etc/profile.d/acurast-env.sh
# The gateway and the interactive SSH session must agree on the Control UI port.
echo "export OPENCLAW_GATEWAY_PORT=$GATEWAY_PORT" >> /etc/profile.d/acurast-env.sh
# OPENCLAW_MODEL may come from the deployment env or fall back to the default
# above; make sure the interactive SSH session sees the resolved value.
echo "export OPENCLAW_MODEL=$OPENCLAW_MODEL" >> /etc/profile.d/acurast-env.sh

cat > /etc/motd <<MOTD

  OpenClaw on Acurast.

  Control UI: open the PRIMARY tunnel URL in your browser (HTTP on :${GATEWAY_PORT}).
  CLI:        you are in the SSH (secondary) session — run:

      openclaw

  OpenClaw is configured to use OpenRouter (model: openrouter/${OPENCLAW_MODEL}).
  OPENROUTER_API_KEY is already exported from your deployment env.
  (If \`openclaw\` is not found yet, the phase-2 install is still running — wait a bit.)

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
# Phase 2 — Node.js + OpenClaw, then the OpenClaw gateway (which serves the
# Control UI). Any failure (or hang) must NOT tear down SSH + the tunnel, so you
# can always SSH in (secondary) to inspect. fail_keep_alive reports the problem
# then blocks on the tunnel.
# =========================================================================
set +e

fail_keep_alive() {
    report_error "$1 — SSH in (secondary connection) to debug; SSH + tunnel left running."
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

# --- Control UI auth (CRITICAL) ---
# The gateway binds loopback and the tunnel forwards FROM loopback, so a default
# config treats every request as local and serves the Control UI WITHOUT auth —
# but the primary tunnel URL is public. Without a password it is an open,
# unauthenticated agent that can run commands. If none was provided, generate a
# strong one and report it via CALLBACK_URL so the URL is never left unprotected.
if [ -z "$OPENCLAW_GATEWAY_PASSWORD" ]; then
    OPENCLAW_GATEWAY_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')"
    export OPENCLAW_GATEWAY_PASSWORD
    echo "export OPENCLAW_GATEWAY_PASSWORD=$OPENCLAW_GATEWAY_PASSWORD" >> /etc/profile.d/acurast-env.sh
    send_callback "{\"event\":\"webui_password\",\"password\":\"${OPENCLAW_GATEWAY_PASSWORD}\"}"
    send_log "OPENCLAW_GATEWAY_PASSWORD was not set — generated one (sent as the webui_password callback event). Use it to log into the Control UI."
fi

# --- OpenClaw config (skip the interactive `openclaw onboard` wizard) ---
# Write a minimal headless config: bind the gateway to loopback on $GATEWAY_PORT
# (the tunnel's PRIMARY connection forwards here), force password auth on the
# Control UI (see above), pin the model provider to OpenRouter, and set the
# default agent model. NOTE: OpenClaw does NOT env-substitute gateway.auth.password
# or models.providers.*.apiKey, so the resolved secret VALUES are inlined here by
# the shell (the heredoc is unquoted). Both values are URL-safe/alphanumeric, so
# they are safe to embed in JSON. The config lives on the ephemeral rootfs only.
send_log "Phase 2: writing OpenClaw config ($OPENCLAW_CONFIG), model=openrouter/$OPENCLAW_MODEL"
mkdir -p "$OPENCLAW_CONFIG_DIR"
if [ -z "$OPENROUTER_API_KEY" ]; then
    send_log "No OPENROUTER_API_KEY set — OpenClaw will start but cannot call a model until you add a key in the Control UI."
fi

# --- Control UI allowed origins (CRITICAL for the public tunnel URL) ---
# The gateway binds loopback and only accepts Control UI WebSocket connections
# whose browser Origin is whitelisted; it does NOT accept wildcards. The public
# tunnel origin (https://<clientId>.<suffix>) is only known once tunnel.py opens
# the tunnel, so wait for it (written to $ORIGIN_FILE) before writing the config.
PRIMARY_ORIGIN=""
i=0
while [ "$i" -lt 60 ]; do
    if [ -s "$ORIGIN_FILE" ]; then
        PRIMARY_ORIGIN="$(cat "$ORIGIN_FILE")"
        break
    fi
    i=$((i + 1))
    sleep 1
done
if [ -n "$PRIMARY_ORIGIN" ]; then
    send_log "Allowing Control UI origin $PRIMARY_ORIGIN"
    ALLOWED_ORIGINS="\"$PRIMARY_ORIGIN\", \"http://localhost:${GATEWAY_PORT}\", \"http://127.0.0.1:${GATEWAY_PORT}\""
else
    report_error "Primary tunnel origin not available after 60s — Control UI will reject the public URL (origin not allowed). The WebUI may be unreachable; SSH still works."
    ALLOWED_ORIGINS="\"http://localhost:${GATEWAY_PORT}\", \"http://127.0.0.1:${GATEWAY_PORT}\""
fi

cat > "$OPENCLAW_CONFIG" <<JSON
{
  "gateway": {
    "mode": "local",
    "port": ${GATEWAY_PORT},
    "bind": "loopback",
    "auth": {
      "mode": "password",
      "password": "${OPENCLAW_GATEWAY_PASSWORD}"
    },
    "controlUi": {
      "allowedOrigins": [ ${ALLOWED_ORIGINS} ]
    }
  },
  "models": {
    "providers": {
      "openrouter": { "apiKey": "${OPENROUTER_API_KEY}" }
    }
  },
  "agents": {
    "defaults": {
      "model": "openrouter/${OPENCLAW_MODEL}"
    }
  }
}
JSON

# --- OpenClaw gateway (serves the Control UI + bridges chat channels). Runs in
# the foreground (the `install` subcommand registers a systemd/launchd service,
# absent in proot), so background it. The Control UI is reachable via the primary
# tunnel; configure chat channels (WhatsApp, Telegram, Discord, Slack, Signal) in
# the UI or via `openclaw onboard` over SSH. ---
send_log "Phase 2: starting OpenClaw gateway (Control UI) on 127.0.0.1:${GATEWAY_PORT}"
# `gateway run` is the FOREGROUND server; plain `gateway` (and `gateway start`)
# expect a service manager (launchd/systemd), absent in proot. `--force` clears
# any stale listener/supervisor holding the port (otherwise a second instance
# fails with "port in use"/lock timeout and requests stall).
openclaw gateway run --port "$GATEWAY_PORT" --force >/tmp/openclaw-gateway.log 2>&1 &
GATEWAY_PID=$!

send_log "OpenClaw ready — open the primary tunnel URL in a browser, or SSH in and run: openclaw"

# Block on the tunnel; if it dies, tear everything down.
TUNNEL_EXIT=0
wait "$TUNNEL_PID" || TUNNEL_EXIT=$?
if [ "$TUNNEL_EXIT" -ne 0 ]; then
    report_error "tunnel exited with status $TUNNEL_EXIT"
    exit "$TUNNEL_EXIT"
fi

wait "$DROPBEAR_PID"
