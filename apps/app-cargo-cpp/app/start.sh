#!/bin/sh

# Entry point for the Shell (cargo) runtime. Sets up the rootfs, installs g++
# and libcurl, then compiles and runs the program which POSTs a JSON payload to
# WEBHOOK_URL.

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root

# The processor leaves TMPDIR pointing at the Android app dir, which doesn't
# exist inside the proot rootfs — point it at a real writable dir.
export TMPDIR="$HOME/tmp"
mkdir -p "$TMPDIR"

echo "nameserver 8.8.8.8" > /etc/resolv.conf

SCRIPT_DIR="$(dirname "$0")"

if [ -z "$WEBHOOK_URL" ]; then
    echo "WEBHOOK_URL not set — configure it in .env" >&2
    exit 1
fi
# Append a language tag so the webhook can attribute the request.
export WEBHOOK_URL="${WEBHOOK_URL%/}/cpp"

# --- Debug reporting (OPTIONAL) ----------------------------------------------
# Posts lifecycle ("startup"/"done") and error reports to the webhook so
# failures are visible — the processor's stdout/stderr is not otherwise
# accessible. NOT required for the example to work: the program does its own
# POST on success. To get a minimal example, delete this block, the
# report/fail calls below, and the `apt-get install -y curl` line.
report() {
    # report <status> [extra-json]
    curl -sS -X POST "$WEBHOOK_URL" -H "Content-Type: application/json" \
        -d "{\"language\":\"cpp\",\"status\":\"$1\"${2:+,$2}}" >/dev/null 2>&1 || true
}
fail() {
    # fail <stage> <exit> <errlog>: post error report, then exit non-zero
    ERRTAIL=$(tail -c 800 "$3" 2>/dev/null | tr -d '\000-\037' | tr -d '\\"')
    report "error" "\"stage\":\"$1\",\"exit\":$2,\"error\":\"$ERRTAIL\""
    exit "$2"
}
# -----------------------------------------------------------------------------

apt-get update
apt-get install -y curl  # OPTIONAL: only needed for the debug reports above
report "startup"

apt-get install -y g++ libcurl4-openssl-dev 2>"$HOME/setup.err" || fail "setup" $? "$HOME/setup.err"

g++ "$SCRIPT_DIR/main.cpp" -lcurl -o "$HOME/cpp-app" 2>"$HOME/build.err" || fail "build" $? "$HOME/build.err"

"$HOME/cpp-app" 2>"$HOME/run.err" || fail "run" $? "$HOME/run.err"

report "done"
