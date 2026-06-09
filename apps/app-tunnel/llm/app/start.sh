#!/bin/sh

echo "=== Setting up environment ==="

apt-get update

if ! command -v curl >/dev/null 2>&1; then
    apt-get install -y curl
fi

SCRIPT_DIR="$(dirname "$0")"
GETIFADDRS_OVERRIDE_SO=/usr/local/lib/libgetifaddrs_override.so

. "$SCRIPT_DIR/callback.sh"

send_log "Setting up environment"

if ! python3 -c "import cryptography" >/dev/null 2>&1; then
    apt-get install -y python3 python3-cryptography
fi

if [ ! -f "$GETIFADDRS_OVERRIDE_SO" ]; then
    echo "=== Building getifaddrs override shim ==="
    apt-get install -y gcc libc6-dev
    mkdir -p "$(dirname "$GETIFADDRS_OVERRIDE_SO")"
    gcc -shared -fPIC -o "$GETIFADDRS_OVERRIDE_SO" "$SCRIPT_DIR/getifaddrs_override.c"
    echo "=== Shim built ==="
fi

mkdir -p /etc/profile.d
echo "export LD_PRELOAD=$GETIFADDRS_OVERRIDE_SO" > /etc/profile.d/ifaddrs-shim.sh

env | sed 's/^/export /' > /etc/profile.d/acurast-env.sh

# --- llama.cpp setup ---
LLAMA_TAG="b9334"
LLAMA_TARBALL="llama-${LLAMA_TAG}-bin-ubuntu-arm64.tar.gz"
LLAMA_URL="https://github.com/ggerganov/llama.cpp/releases/download/${LLAMA_TAG}/${LLAMA_TARBALL}"
LLAMA_DIR="/opt/llama"

MODEL_URL="https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf"
MODEL_PATH="/opt/models/Qwen2.5-3B-Instruct-Q4_K_M.gguf"

if [ ! -d "$LLAMA_DIR" ]; then
    echo "=== Downloading llama.cpp ${LLAMA_TAG} ==="
    send_log "Downloading llama.cpp ${LLAMA_TAG}"
    mkdir -p "$LLAMA_DIR"
    curl -L --max-time 300 "$LLAMA_URL" -o "/tmp/${LLAMA_TARBALL}"
    tar -xzf "/tmp/${LLAMA_TARBALL}" -C "$LLAMA_DIR" --strip-components=1
    rm "/tmp/${LLAMA_TARBALL}"
    echo "=== llama.cpp installed ==="
fi

if [ ! -f "$MODEL_PATH" ]; then
    echo "=== Downloading Qwen 2.5 3B Q4_K_M ==="
    send_log "Downloading Qwen 2.5 3B model (~2GB)"
    mkdir -p "$(dirname "$MODEL_PATH")"
    curl -L --max-time 900 "$MODEL_URL" -o "$MODEL_PATH"
    echo "=== Model downloaded ==="
fi

# --- Start llama-server ---
LLAMA_PORT=8080

echo "=== llama-server starting on 127.0.0.1:${LLAMA_PORT} ==="
send_log "Starting llama-server on port ${LLAMA_PORT}"

LD_PRELOAD="$GETIFADDRS_OVERRIDE_SO" \
    "$LLAMA_DIR/llama-server" \
    --model "$MODEL_PATH" \
    --host 127.0.0.1 \
    --port "$LLAMA_PORT" \
    --ctx-size 4096 \
    --threads 4 \
    2>/tmp/llama.err \
    &
LLAMA_PID=$!

trap 'kill $LLAMA_PID $TUNNEL_PID 2>/dev/null' INT TERM EXIT

# Wait for llama-server to be ready before opening tunnel
echo "=== Waiting for llama-server to load model ==="
send_log "Waiting for llama-server to load model"
for i in $(seq 1 120); do
    if curl -s http://127.0.0.1:${LLAMA_PORT}/health | grep -q '"status":"ok"'; then
        echo "=== llama-server ready ==="
        send_log "llama-server ready"
        break
    fi
    if ! kill -0 $LLAMA_PID 2>/dev/null; then
        LLAMA_TAIL=$(tail -20 /tmp/llama.err 2>/dev/null | tr -d '"\\' | tr '\n' ' ' | cut -c1-800)
        echo "ERROR: llama-server died during startup: $LLAMA_TAIL"
        report_error "llama-server died during startup: $LLAMA_TAIL"
        exit 1
    fi
    sleep 2
done

if ! curl -s http://127.0.0.1:${LLAMA_PORT}/health | grep -q '"status":"ok"'; then
    LLAMA_TAIL=$(tail -20 /tmp/llama.err 2>/dev/null | tr -d '"\\' | tr '\n' ' ' | cut -c1-800)
    echo "ERROR: llama-server failed to start within 240s: $LLAMA_TAIL"
    report_error "llama-server failed to start within 240s: $LLAMA_TAIL"
    kill $LLAMA_PID 2>/dev/null
    exit 1
fi

# --- Start tunnel ---
send_log "llama-server ready, starting Acurast reverse tunnel"

LD_PRELOAD="$GETIFADDRS_OVERRIDE_SO" python3 "$SCRIPT_DIR/tunnel.py" &
TUNNEL_PID=$!

wait $TUNNEL_PID
TUNNEL_EXIT=$?

if [ $TUNNEL_EXIT -ne 0 ]; then
    echo "ERROR: tunnel exited with status $TUNNEL_EXIT"
    report_error "tunnel exited with status $TUNNEL_EXIT"
    exit $TUNNEL_EXIT
fi

wait $LLAMA_PID
