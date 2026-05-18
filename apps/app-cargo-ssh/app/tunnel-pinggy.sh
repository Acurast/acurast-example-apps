#!/bin/sh

start_tunnel() {
    if ! command -v ssh >/dev/null 2>&1; then
        apt-get install -y openssh-client
    fi

    echo "=== Starting pinggy tunnel ==="
    if [ -n "$PINGGY_ACCESS_TOKEN" ]; then
        PINGGY_USER="${PINGGY_ACCESS_TOKEN}+tcp"
    else
        PINGGY_USER="tcp"
    fi
    ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 \
        -p 443 -R0:127.0.0.1:2222 "${PINGGY_USER}@free.pinggy.io" > /tmp/pinggy.log 2>&1 &
    TUNNEL_PID=$!

    PINGGY_HOST=""
    ATTEMPTS=0
    while [ -z "$PINGGY_HOST" ] && [ $ATTEMPTS -lt 20 ]; do
        sleep 1
        PINGGY_HOST=$(grep -o '[a-z0-9.-]*\.pinggy-free\.link:[0-9]*' /tmp/pinggy.log | head -1)
        ATTEMPTS=$((ATTEMPTS + 1))
    done

    TUNNEL_HOST=$(echo "$PINGGY_HOST" | cut -d: -f1)
    TUNNEL_PORT=$(echo "$PINGGY_HOST" | cut -d: -f2)
}
