# Load util callback functions

echo "=== Setting up environment ==="

# Update package list and install dependencies
apt-get update

# Install curl if not present
if ! command -v curl >/dev/null 2>&1; then
    apt-get install -y curl
fi

SCRIPT_DIR="$(dirname "$0")"
GETIFADDRS_OVERRIDE_SO=/usr/local/lib/libgetifaddrs_override.so

. "$SCRIPT_DIR/callback.sh"

send_log "Setting up environment"

# Install dropbear if not present
if ! command -v dropbear >/dev/null 2>&1; then
    apt-get install -y dropbear
fi

# Build getifaddrs override shim if not present
if [ ! -f "$GETIFADDRS_OVERRIDE_SO" ]; then
    echo "=== Building getifaddrs override shim ==="
    apt-get install -y gcc libc6-dev
    mkdir -p "$(dirname "$GETIFADDRS_OVERRIDE_SO")"
    gcc -shared -fPIC -o "$GETIFADDRS_OVERRIDE_SO" "$SCRIPT_DIR/getifaddrs_override.c"
    echo "=== Shim built ==="
fi

# Set LD_PRELOAD for SSH sessions
mkdir -p /etc/profile.d
echo "export LD_PRELOAD=$GETIFADDRS_OVERRIDE_SO" > /etc/profile.d/ifaddrs-shim.sh

# Export current env vars to SSH sessions
env | sed 's/^/export /' > /etc/profile.d/acurast-env.sh

# Set root password
echo "root:${SSH_PASSWORD:-password}" | chpasswd

# Generate host keys if missing
mkdir -p /etc/dropbear
dropbearkey -t rsa -f /etc/dropbear/dropbear_rsa_host_key 2>/dev/null || true
dropbearkey -t ecdsa -f /etc/dropbear/dropbear_ecdsa_host_key 2>/dev/null || true

echo "=== SSH server starting on port 2222 ==="
send_log "Local SSH server starting on port 2222"

# Start the SSH server in foreground mode so it stays a child process
dropbear -F -E -p 2222 -R &
DROPBEAR_PID=$!

trap 'kill $DROPBEAR_PID $TUNNEL_PID 2>/dev/null' INT TERM EXIT

send_log "Local SSH server ready, starting tunnel"

# Source and start the selected tunnel
case "$SSH_TUNNEL" in
    ngrok|bore|pinggy) . "$SCRIPT_DIR/tunnel-${SSH_TUNNEL}.sh" ;;
    *)
        echo "ERROR: SSH_TUNNEL must be one of: ngrok, bore, pinggy"
        report_error "SSH_TUNNEL must be one of: ngrok, bore, pinggy"
        exit 1
        ;;
esac

start_tunnel || exit 1

if [ -n "$TUNNEL_HOST" ] && [ -n "$TUNNEL_PORT" ]; then
    echo "=== Tunnel ready ==="
    echo "Connect: ssh root@${TUNNEL_HOST} -p ${TUNNEL_PORT}"
    report_started "$TUNNEL_HOST" "$TUNNEL_PORT"
else
    echo "ERROR: Could not retrieve tunnel address"
    report_error "Could not retrieve tunnel address"
fi

wait $DROPBEAR_PID
