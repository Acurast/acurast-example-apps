#!/bin/sh

start_tunnel() {
    if [ ! -f /usr/local/bin/bore ]; then
        echo "=== Installing bore ==="
        apt-get install -y wget tar
        ARCH=$(uname -m)
        case "$ARCH" in
            aarch64) BORE_ARCH="aarch64-unknown-linux-musl" ;;
            armv7l)  BORE_ARCH="armv7-unknown-linux-musleabihf" ;;
            x86_64)  BORE_ARCH="x86_64-unknown-linux-musl" ;;
            *)
                echo "ERROR: Unsupported architecture: $ARCH"
                report_error "Unsupported architecture: $ARCH"
                return 1
                ;;
        esac
        BORE_VERSION=$(wget -qO- https://api.github.com/repos/ekzhang/bore/releases/latest \
            | grep '"tag_name"' | head -1 | cut -d'"' -f4)
        wget -q -O /tmp/bore.tar.gz \
            "https://github.com/ekzhang/bore/releases/download/${BORE_VERSION}/bore-${BORE_VERSION}-${BORE_ARCH}.tar.gz"
        tar -xzf /tmp/bore.tar.gz -C /usr/local/bin bore
        rm /tmp/bore.tar.gz
        echo "=== bore installed ==="
    fi

    echo "=== Starting bore tunnel ==="
    bore local 2222 --to bore.pub --local-host 127.0.0.1 > /tmp/bore.log 2>&1 &
    TUNNEL_PID=$!

    BORE_PORT=""
    ATTEMPTS=0
    while [ -z "$BORE_PORT" ] && [ $ATTEMPTS -lt 20 ]; do
        sleep 1
        BORE_PORT=$(grep -o 'bore\.pub:[0-9]*' /tmp/bore.log | head -1 | cut -d: -f2)
        ATTEMPTS=$((ATTEMPTS + 1))
    done

    TUNNEL_HOST="bore.pub"
    TUNNEL_PORT="$BORE_PORT"
}
