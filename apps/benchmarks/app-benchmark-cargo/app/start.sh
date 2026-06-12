#!/bin/sh

# Entry point for the cargo / proot Shell-runtime deployment.
# Sets up the Ubuntu rootfs, installs Node.js, runs the benchmark, and POSTs
# the result via curl.
#
# NOTE: we deliberately POST with curl (not Node's fetch). Node's fetch/undici
# is unreliable under proot (broken getifaddrs / interface enumeration), which
# is why the other cargo examples in this repo report via curl or python too.
# Node here only does pure compute + prints JSON to stdout — no network.

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root

# The processor leaves TMPDIR pointing at the Android app dir, which doesn't
# exist inside the proot rootfs — point it at a real writable dir so apt /
# NodeSource temp work doesn't fail.
export TMPDIR="$HOME/tmp"
mkdir -p "$TMPDIR"

echo "nameserver 8.8.8.8" > /etc/resolv.conf

SCRIPT_DIR="$(dirname "$0")"
# WEBHOOK_URL comes from .env (passed via includeEnvironmentVariables); no
# hardcoded channel. Append an env-specific subPath for per-app attribution.
if [ -z "$WEBHOOK_URL" ]; then
    echo "WEBHOOK_URL not set — configure it in .env" >&2
    exit 1
fi
WEBHOOK_URL="${WEBHOOK_URL%/}/cargo"

# --- Measure rootfs setup cost (apt + node install) separately from compute ---
# Ubuntu apt only ships Node 20; install Node 24 via NodeSource so the engine
# matches the native runtime (and the comparison isolates proot, not the Node
# version). NOTE: NodeSource has no 32-bit armhf build for Node 24, so this will
# fail loud on the few arm (not arm64) processors — that is intentional.
NODE_MAJOR=24
SETUP_START=$(date +%s%3N)
apt-get update
apt-get install -y curl ca-certificates
curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
apt-get install -y nodejs
SETUP_END=$(date +%s%3N)
export SETUP_MS=$((SETUP_END - SETUP_START))

echo "node version: $(node --version)"
echo "setup (NodeSource ${NODE_MAJOR}.x + node + curl install) took ${SETUP_MS} ms"

# Writable dir for the file IO benchmark (the rootfs may not have /tmp).
export BENCH_TMP="$HOME/bench-tmp"
mkdir -p "$BENCH_TMP"

# --- Network benchmark (curl; best-effort) ---
# Throughput: download 10 MB and read curl's measured speed. Parallel: fire 20
# concurrent 100 KB downloads and time the batch. Reported via NET_* env vars.
# Done with curl (not Node fetch) for the same proot reasons as the report POST.
net_benchmark() {
    NET_PARALLEL_COUNT=20
    DL="https://speed.cloudflare.com/__down?bytes=10000000"
    SMALL="https://speed.cloudflare.com/__down?bytes=100000"
    MEAS=$(curl -s -o /dev/null -w '%{speed_download} %{time_total}' "$DL" 2>/dev/null)
    NET_THROUGHPUT_MBPS=$(echo "$MEAS" | awk '{printf "%.2f", $1*8/1000000}')
    NET_DOWNLOAD_MS=$(echo "$MEAS" | awk '{printf "%d", $2*1000}')
    PSTART=$(date +%s%3N)
    i=0
    while [ "$i" -lt "$NET_PARALLEL_COUNT" ]; do
        curl -s -o /dev/null "$SMALL" 2>/dev/null &
        i=$((i + 1))
    done
    wait
    PEND=$(date +%s%3N)
    NET_PARALLEL_MS=$((PEND - PSTART))
    export NET_THROUGHPUT_MBPS NET_DOWNLOAD_MS NET_PARALLEL_MS NET_PARALLEL_COUNT
    echo "net: ${NET_THROUGHPUT_MBPS} Mbps, ${NET_PARALLEL_COUNT} parallel in ${NET_PARALLEL_MS} ms"
}
net_benchmark || echo "network benchmark failed (continuing)" >&2

# Run the benchmark. bench.js prints ONLY the JSON payload to stdout; human
# logs / errors go to stderr, which we capture so we can report failures.
ERR_LOG="$HOME/bench.err"
RESULT=$(node "$SCRIPT_DIR/bench.js" 2>"$ERR_LOG")
STATUS=$?

# On failure (non-zero exit or empty output) POST an error report instead of an
# empty {} body — the processor's stdout/stderr isn't otherwise visible to us.
# Then exit non-zero so the on-chain fulfillment also reflects the failure.
if [ "$STATUS" -ne 0 ] || [ -z "$RESULT" ]; then
    ERRTAIL=$(tail -c 800 "$ERR_LOG" 2>/dev/null | tr -d '\000-\037' | tr -d '\\"')
    echo "benchmark failed (exit=$STATUS); posting error report" >&2
    curl -sS -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "{\"environment\":\"cargo\",\"status\":\"error\",\"stage\":\"run\",\"exit\":$STATUS,\"error\":\"$ERRTAIL\"}"
    echo ""
    exit "$([ "$STATUS" -ne 0 ] && echo "$STATUS" || echo 1)"
fi

echo "posting result to $WEBHOOK_URL"
curl -sS -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "$RESULT"
echo ""
echo "done"
