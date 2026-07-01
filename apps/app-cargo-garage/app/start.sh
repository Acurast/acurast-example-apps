#!/bin/sh
set -e

# Cargo entrypoint: runs a single-node Garage (https://garagehq.deuxfleurs.fr)
# S3 object store and exposes it over the Acurast reverse tunnel's two
# connections — PRIMARY (Let's Encrypt) forwards the S3 API, SECONDARY
# (self-signed) forwards dropbear SSH for shell access. S3 endpoint =
# https://<clientId>.<DOMAIN_SUFFIX> (path-style, region "garage"). Access keys
# are generated at startup and reported to CALLBACK_URL.
#
# Setup is split into two phases on purpose: phase 1 installs the minimal deps,
# brings up SSH, and starts the tunnel FIRST, so if the Garage setup in phase 2
# stalls or fails you can still SSH into the machine to debug it live.

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
GARAGE_VERSION=v1.0.1
GARAGE_BIN=/usr/local/bin/garage
GARAGE_CONF=/etc/garage.toml
BUCKET="${GARAGE_BUCKET:-bucket}"
WEB_PORT=3900           # S3 API port — the tunnel's PRIMARY connection forwards this
export WEB_PORT
SSH_PORT=2222

GARAGE_PID=""
TUNNEL_PID=""
DROPBEAR_PID=""

apt-get update
if ! command -v curl >/dev/null 2>&1; then apt-get install -y curl; fi

. "$SCRIPT_DIR/callback.sh"

finish() {
    code=$?
    [ -n "$DROPBEAR_PID" ] && kill "$DROPBEAR_PID" 2>/dev/null || true
    [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
    [ -n "$GARAGE_PID" ] && kill "$GARAGE_PID" 2>/dev/null || true
    if [ "$code" -ne 0 ]; then
        echo "ERROR: start.sh exiting with code $code"
        report_error "start.sh exited with code $code"
    fi
    exit "$code"
}
trap finish EXIT INT TERM

# =========================================================================
# Phase 1 — minimal deps, SSH, and the tunnel. Keep this fast and reliable so
# the deployment is reachable before the heavy setup runs.
# =========================================================================
send_log "Phase 1: installing SSH + tunnel deps (dropbear, python3, build tools)"
apt-get install -y dropbear gcc libc6-dev python3 python3-cryptography ca-certificates openssl

# --- getifaddrs shim (PRoot has no real interfaces; fake a loopback) ---
if [ ! -f "$GETIFADDRS_OVERRIDE_SO" ]; then
    mkdir -p "$(dirname "$GETIFADDRS_OVERRIDE_SO")"
    gcc -shared -fPIC -o "$GETIFADDRS_OVERRIDE_SO" "$SCRIPT_DIR/getifaddrs_override.c"
fi
export LD_PRELOAD="$GETIFADDRS_OVERRIDE_SO"

# --- SSH (dropbear) on 127.0.0.1:2222 (the tunnel's SECONDARY connection forwards this) ---
# Login shells get the getifaddrs shim and the deployment env so the SSH session
# behaves like the entrypoint (no systemd here, so we seed /etc/profile.d directly).
mkdir -p /etc/profile.d
echo "export LD_PRELOAD=$GETIFADDRS_OVERRIDE_SO" > /etc/profile.d/ifaddrs-shim.sh
env | sed 's/^/export /' > /etc/profile.d/acurast-env.sh

echo "root:${SSH_PASSWORD:-password}" | chpasswd
mkdir -p /etc/dropbear
dropbearkey -t rsa -f /etc/dropbear/dropbear_rsa_host_key 2>/dev/null || true
dropbearkey -t ecdsa -f /etc/dropbear/dropbear_ecdsa_host_key 2>/dev/null || true

send_log "Starting SSH (dropbear) on 127.0.0.1:${SSH_PORT}"
dropbear -F -E -p "$SSH_PORT" -R &
DROPBEAR_PID=$!

# Start the tunnel now — the SSH (secondary) connection becomes reachable
# immediately; the S3 API (primary) starts serving once Garage binds WEB_PORT.
send_log "SSH up, starting Acurast reverse tunnel"
python3 "$SCRIPT_DIR/tunnel.py" &
TUNNEL_PID=$!

# =========================================================================
# Phase 2 — Garage S3. Any failure (or hang) must NOT tear down SSH + the
# tunnel, so you can always SSH in (secondary connection) to inspect.
# fail_keep_alive reports the problem then blocks on the tunnel.
# =========================================================================
set +e

fail_keep_alive() {
    report_error "$1 — SSH in over the secondary tunnel to debug; SSH + tunnel left running."
    send_log "Phase 2 failed; keeping SSH + tunnel alive for debugging"
    wait "$TUNNEL_PID"
    exit 1
}

# --- Garage binary (static musl build for aarch64) ---
if [ ! -x "$GARAGE_BIN" ]; then
    send_log "Phase 2: downloading Garage ${GARAGE_VERSION}"
    curl -fsSL "https://garagehq.deuxfleurs.fr/_releases/${GARAGE_VERSION}/aarch64-unknown-linux-musl/garage" \
        -o "$GARAGE_BIN" || fail_keep_alive "Garage binary download failed"
    chmod +x "$GARAGE_BIN"
fi

# --- Config (single node, replication factor 1) ---
mkdir -p /var/lib/garage/meta /var/lib/garage/data
RPC_SECRET="$(openssl rand -hex 32)"
ADMIN_TOKEN="$(openssl rand -hex 32)"
cat > "$GARAGE_CONF" <<CONF
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"

replication_factor = 1

rpc_bind_addr = "127.0.0.1:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "${RPC_SECRET}"

[s3_api]
s3_region = "garage"
api_bind_addr = "127.0.0.1:${WEB_PORT}"
root_domain = ".s3.garage"

[s3_web]
bind_addr = "127.0.0.1:3902"
root_domain = ".web.garage"
index = "index.html"

[admin]
api_bind_addr = "127.0.0.1:3903"
admin_token = "${ADMIN_TOKEN}"
CONF

send_log "Phase 2: starting Garage server"
"$GARAGE_BIN" -c "$GARAGE_CONF" server >/tmp/garage.log 2>&1 &
GARAGE_PID=$!

# Wait for the node to come up.
ATTEMPTS=0
until "$GARAGE_BIN" -c "$GARAGE_CONF" status >/dev/null 2>&1; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ $ATTEMPTS -ge 60 ]; then
        fail_keep_alive "Garage did not become ready: $(tail -c 400 /tmp/garage.log | tr -d '\"')"
    fi
    sleep 1
done

# --- Single-node cluster layout ---
NODE_ID="$("$GARAGE_BIN" -c "$GARAGE_CONF" node id -q | cut -d@ -f1)"
"$GARAGE_BIN" -c "$GARAGE_CONF" layout assign -z dc1 -c 1G "$NODE_ID" \
    || fail_keep_alive "Garage layout assign failed"
"$GARAGE_BIN" -c "$GARAGE_CONF" layout apply --version 1 \
    || fail_keep_alive "Garage layout apply failed"

# --- Bucket + access key ---
send_log "Creating bucket '${BUCKET}' and access key"
"$GARAGE_BIN" -c "$GARAGE_CONF" bucket create "$BUCKET" 2>/dev/null || true
"$GARAGE_BIN" -c "$GARAGE_CONF" key create app-key 2>/dev/null || true
KEY_INFO="$("$GARAGE_BIN" -c "$GARAGE_CONF" key info app-key --show-secret)"
ACCESS_KEY="$(echo "$KEY_INFO" | grep -i 'Key ID' | head -1 | awk '{print $NF}')"
SECRET_KEY="$(echo "$KEY_INFO" | grep -i 'Secret key' | head -1 | awk '{print $NF}')"
"$GARAGE_BIN" -c "$GARAGE_CONF" bucket allow --read --write --owner "$BUCKET" --key app-key

# The public URL is reported by tunnel.py; report the S3 credentials here.
send_callback "{\"event\":\"credentials\",\"region\":\"garage\",\"bucket\":\"${BUCKET}\",\"accessKeyId\":\"${ACCESS_KEY}\",\"secretAccessKey\":\"${SECRET_KEY}\"}"
echo "=== Garage ready: bucket=${BUCKET} accessKey=${ACCESS_KEY} ==="
send_log "Garage S3 up; deployment fully live"

# Block on the tunnel; if it dies, tear everything down.
TUNNEL_EXIT=0
wait "$TUNNEL_PID" || TUNNEL_EXIT=$?
if [ "$TUNNEL_EXIT" -ne 0 ]; then
    report_error "tunnel exited with status $TUNNEL_EXIT"
    exit "$TUNNEL_EXIT"
fi

wait "$GARAGE_PID"
