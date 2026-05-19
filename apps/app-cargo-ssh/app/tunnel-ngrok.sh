#!/bin/sh

start_tunnel() {
    if [ ! -f /usr/local/bin/ngrok ]; then
        echo "=== Installing ngrok ==="
        apt-get install -y tar
        ARCH=$(uname -m)
        case "$ARCH" in
            aarch64) NGROK_ARCH="arm64" ;;
            armv7l)  NGROK_ARCH="arm"   ;;
            x86_64)  NGROK_ARCH="amd64" ;;
            *)
                echo "ERROR: Unsupported architecture: $ARCH"
                report_error "Unsupported architecture: $ARCH"
                return 1
                ;;
        esac
        curl -sL -o /tmp/ngrok.tgz \
            "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${NGROK_ARCH}.tgz"
        tar -xzf /tmp/ngrok.tgz -C /usr/local/bin ngrok
        rm /tmp/ngrok.tgz
        echo "=== ngrok installed ==="
    fi

    if [ -z "$NGROK_AUTHTOKEN" ]; then
        echo "ERROR: NGROK_AUTHTOKEN environment variable is not set"
        report_error "NGROK_AUTHTOKEN environment variable is not set"
        return 1
    fi
    ngrok config add-authtoken "$NGROK_AUTHTOKEN"

    echo "=== Starting ngrok tunnel ==="
    ngrok tcp 127.0.0.1:2222 --log stderr &
    TUNNEL_PID=$!

    TUNNEL_URL=""
    ATTEMPTS=0
    while [ -z "$TUNNEL_URL" ] && [ $ATTEMPTS -lt 20 ]; do
        sleep 1
        TUNNEL_URL=$(curl -s http://localhost:4040/api/tunnels \
            | grep -o '"public_url":"tcp://[^"]*"' \
            | head -1 \
            | cut -d'"' -f4)
        ATTEMPTS=$((ATTEMPTS + 1))
    done

    TUNNEL_HOST=$(echo "$TUNNEL_URL" | sed 's|tcp://||' | cut -d: -f1)
    TUNNEL_PORT=$(echo "$TUNNEL_URL" | sed 's|tcp://||' | cut -d: -f2)
}
