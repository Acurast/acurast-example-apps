#!/bin/sh

# Entry point for the cargo-native (Rust) Shell-runtime deployment.
# Installs the Rust toolchain, compiles the benchmark, runs it, and POSTs the
# result via curl.
#
# Same workload as the Node deployments (app-benchmark-cargo / -nodejs) but
# compiled native code instead of JS. The Rust source is std-only, so the build
# needs no network (no crates.io fetch) — only the apt toolchain.
# We POST with curl, not from Rust, to keep the binary free of networking under
# proot (matches the other cargo examples).

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root

# The processor leaves TMPDIR pointing at the Android app dir
# (/data/user/0/com.acurast...), which doesn't exist inside the proot rootfs —
# cargo build then fails with "couldn't create a temp dir". Point it at a real
# writable dir inside the rootfs.
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
WEBHOOK_URL="${WEBHOOK_URL%/}/cargo-native"
export CARGO_TARGET_DIR="$HOME/target"

# --- Install toolchain (measured separately from build + compute) ---
SETUP_START=$(date +%s%3N)
apt-get update
apt-get install -y cargo curl ca-certificates
SETUP_END=$(date +%s%3N)
export BENCH_SETUP_MS=$((SETUP_END - SETUP_START))
echo "cargo version: $(cargo --version)"
echo "toolchain install took ${BENCH_SETUP_MS} ms"

# --- Compile (measured separately) ---
# Capture build stderr and check its exit code: if the build fails (missing
# cargo, compile error, or OOM-killed link), report the real reason instead of
# letting start.sh run a non-existent binary and report a useless "not found".
BUILD_LOG="$HOME/build.err"
BUILD_START=$(date +%s%3N)
cargo build --release --manifest-path "$SCRIPT_DIR/Cargo.toml" 2>"$BUILD_LOG"
BUILD_STATUS=$?
BUILD_END=$(date +%s%3N)
export BENCH_BUILD_MS=$((BUILD_END - BUILD_START))
echo "build took ${BENCH_BUILD_MS} ms (status=$BUILD_STATUS)"

if [ "$BUILD_STATUS" -ne 0 ]; then
    ERRTAIL=$(tail -c 800 "$BUILD_LOG" 2>/dev/null | tr -d '\000-\037' | tr -d '\\"')
    echo "cargo build failed (exit=$BUILD_STATUS); posting error report" >&2
    curl -sS -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "{\"environment\":\"cargo-native\",\"status\":\"error\",\"stage\":\"build\",\"exit\":$BUILD_STATUS,\"error\":\"$ERRTAIL\"}"
    echo ""
    exit "$BUILD_STATUS"
fi

# Writable dir for the file IO benchmark (the rootfs may not have /tmp).
export BENCH_TMP="$HOME/bench-tmp"
mkdir -p "$BENCH_TMP"

# --- Network benchmark (curl; best-effort) ---
# Throughput: download 10 MB and read curl's measured speed. Parallel: fire 20
# concurrent 100 KB downloads and time the batch. Reported via NET_* env vars.
# Same curl approach as the cargo-node app so the two are directly comparable.
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

# Run the benchmark. The binary prints ONLY the JSON payload to stdout; human
# logs / panics go to stderr, which we capture so we can report failures.
ERR_LOG="$HOME/bench.err"
RESULT=$("$CARGO_TARGET_DIR/release/bench" 2>"$ERR_LOG")
STATUS=$?

# On failure (non-zero exit or empty output) POST an error report instead of an
# empty {} body — the processor's stdout/stderr isn't otherwise visible to us.
# Then exit non-zero so the on-chain fulfillment also reflects the failure.
if [ "$STATUS" -ne 0 ] || [ -z "$RESULT" ]; then
    ERRTAIL=$(tail -c 800 "$ERR_LOG" 2>/dev/null | tr -d '\000-\037' | tr -d '\\"')
    echo "benchmark failed (exit=$STATUS); posting error report" >&2
    curl -sS -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "{\"environment\":\"cargo-native\",\"status\":\"error\",\"stage\":\"run\",\"exit\":$STATUS,\"error\":\"$ERRTAIL\"}"
    echo ""
    exit "$([ "$STATUS" -ne 0 ] && echo "$STATUS" || echo 1)"
fi

echo "posting result to $WEBHOOK_URL"
curl -sS -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "$RESULT"
echo ""
echo "done"
