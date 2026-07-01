#!/bin/sh
set -e

# Cargo entrypoint: runs a Minecraft Java server bound to loopback and exposes it
# over the Acurast reverse tunnel's two connections — PRIMARY forwards the game
# port directly, SECONDARY forwards dropbear SSH. Because Minecraft's wire
# protocol is raw TCP (not TLS), the easy play path is an SSH local forward over
# the secondary connection:
#   ssh -L 25565:127.0.0.1:25565 ... then connect a client to 127.0.0.1:25565.
#
# Deploying this accepts the Minecraft EULA (https://aka.ms/MinecraftEULA):
# start.sh writes eula=true.

echo "=== Setting up environment ==="
export HOME=/root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GETIFADDRS_OVERRIDE_SO=/usr/local/lib/libgetifaddrs_override.so
SSH_PORT=2222
MC_PORT=25565
SERVER_DIR=/opt/minecraft
# Pinned vanilla 26.2 server jar; override with MC_SERVER_URL.
# Note: this build requires Java 25 (see JDK install below).
DEFAULT_JAR_URL="https://piston-data.mojang.com/v1/objects/823e2250d24b3ddac457a60c92a6a941943fcd6a/server.jar"
JAR_URL="${MC_SERVER_URL:-$DEFAULT_JAR_URL}"

DROPBEAR_PID=""
MC_PID=""
TUNNEL_PID=""

apt-get update
if ! command -v curl >/dev/null 2>&1; then apt-get install -y curl; fi

. "$SCRIPT_DIR/callback.sh"

finish() {
    code=$?
    [ -n "$DROPBEAR_PID" ] && kill "$DROPBEAR_PID" 2>/dev/null || true
    [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
    [ -n "$MC_PID" ] && kill "$MC_PID" 2>/dev/null || true
    if [ "$code" -ne 0 ]; then
        echo "ERROR: start.sh exiting with code $code"
        report_error "start.sh exited with code $code"
    fi
    exit "$code"
}
trap finish EXIT INT TERM

send_log "Installing Minecraft server stack (JDK + dropbear)"
apt-get install -y dropbear gcc libc6-dev \
    python3 python3-cryptography ca-certificates
# Minecraft 26.2 needs Java 25. Prefer the explicit package; fall back to the
# distro default JDK (override MC_SERVER_URL with an older jar if it's too old).
apt-get install -y openjdk-25-jdk-headless || apt-get install -y default-jdk-headless

# --- getifaddrs shim (PRoot has no real interfaces; fake a loopback) ---
if [ ! -f "$GETIFADDRS_OVERRIDE_SO" ]; then
    mkdir -p "$(dirname "$GETIFADDRS_OVERRIDE_SO")"
    gcc -shared -fPIC -o "$GETIFADDRS_OVERRIDE_SO" "$SCRIPT_DIR/getifaddrs_override.c"
fi
export LD_PRELOAD="$GETIFADDRS_OVERRIDE_SO"

# --- Minecraft server ---
mkdir -p "$SERVER_DIR"
if [ ! -f "$SERVER_DIR/server.jar" ]; then
    send_log "Downloading Minecraft server jar"
    curl -fsSL "$JAR_URL" -o "$SERVER_DIR/server.jar"
fi

# Accept the EULA (deploying this app constitutes acceptance).
echo "eula=true" > "$SERVER_DIR/eula.txt"

# Bind to loopback only — it's reached through the SSH local forward.
if [ ! -f "$SERVER_DIR/server.properties" ]; then
    cat > "$SERVER_DIR/server.properties" <<PROPS
server-ip=127.0.0.1
server-port=${MC_PORT}
motd=Minecraft on Acurast
online-mode=true
max-players=10
spawn-protection=0
PROPS
fi

# --- SSH (dropbear) ---
echo "root:${SSH_PASSWORD:-password}" | chpasswd
mkdir -p /etc/dropbear /etc/profile.d
echo "export LD_PRELOAD=$GETIFADDRS_OVERRIDE_SO" > /etc/profile.d/ifaddrs-shim.sh
dropbearkey -t rsa -f /etc/dropbear/dropbear_rsa_host_key 2>/dev/null || true
dropbearkey -t ecdsa -f /etc/dropbear/dropbear_ecdsa_host_key 2>/dev/null || true

cat > /etc/motd <<MOTD

  Minecraft server on Acurast (loopback :${MC_PORT}).
  SSH rides the tunnel's SECONDARY connection. From your machine, forward the
  game port through this SSH session (use the secondary clientId, port 443):

      ssh -N -L ${MC_PORT}:127.0.0.1:${MC_PORT} ... root@<secondaryClientId>

  then add server  127.0.0.1:${MC_PORT}  in your Minecraft client.

MOTD

send_log "Starting Minecraft server on 127.0.0.1:${MC_PORT}"
( cd "$SERVER_DIR" && java -Xmx1024M -Xms512M -jar server.jar nogui ) >/tmp/minecraft.log 2>&1 &
MC_PID=$!

echo "=== SSH server starting on port ${SSH_PORT} ==="
send_log "Local SSH server starting on port ${SSH_PORT}"
dropbear -F -E -p "$SSH_PORT" -R &
DROPBEAR_PID=$!

send_log "Local SSH server ready, starting Acurast reverse tunnel"
python3 "$SCRIPT_DIR/tunnel.py" &
TUNNEL_PID=$!

TUNNEL_EXIT=0
wait "$TUNNEL_PID" || TUNNEL_EXIT=$?
if [ "$TUNNEL_EXIT" -ne 0 ]; then
    report_error "tunnel exited with status $TUNNEL_EXIT"
    exit "$TUNNEL_EXIT"
fi

wait "$DROPBEAR_PID"
