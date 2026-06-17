#!/bin/sh

# Entry point for the Shell (cargo) runtime. Sets up the rootfs, installs the
# Mono C# compiler + runtime, then compiles and runs the program which POSTs a
# JSON payload to WEBHOOK_URL.

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
export WEBHOOK_URL="${WEBHOOK_URL%/}/csharp"

# --- Debug reporting (OPTIONAL) ----------------------------------------------
# Posts lifecycle ("startup"/"done") and error reports to the webhook so
# failures are visible — the processor's stdout/stderr is not otherwise
# accessible. NOT required for the example to work: the program does its own
# POST on success. To get a minimal example, delete this block, the
# report/fail calls below, and the `apt-get install -y curl` line.
report() {
    # report <status> [extra-json]
    curl -sS -X POST "$WEBHOOK_URL" -H "Content-Type: application/json" \
        -d "{\"language\":\"csharp\",\"status\":\"$1\"${2:+,$2}}" >/dev/null 2>&1 || true
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

apt-get install -y mono-mcs mono-runtime 2>"$HOME/setup.err" || fail "setup" $? "$HOME/setup.err"
report "setup-done"

# Mono's managed DNS resolver fails under proot (NameResolutionFailure) and
# ignores /etc/hosts, so we can't fix it from the shell. Instead pre-resolve the
# webhook host with the working libc resolver and hand Mono the raw IP via
# WEBHOOK_IP — Main.cs connects to the IP and sends the real host in the Host
# header, so Mono never does a DNS lookup at all.
# Use `ahostsv4` to force IPv4: there is no IPv6 under proot.
WEBHOOK_HOST=$(printf '%s' "$WEBHOOK_URL" | sed -e 's|^[a-z][a-z]*://||' -e 's|[:/].*$||')
WEBHOOK_IP=$(getent ahostsv4 "$WEBHOOK_HOST" | awk '{ print $1; exit }')
export WEBHOOK_IP
echo "resolved $WEBHOOK_HOST -> ${WEBHOOK_IP:-<none>}"

mcs "$SCRIPT_DIR/Main.cs" -r:System.dll -out:"$HOME/cs-app.exe" 2>"$HOME/build.err" || fail "build" $? "$HOME/build.err"
report "build-done"

mono "$HOME/cs-app.exe" 2>"$HOME/run.err" || fail "run" $? "$HOME/run.err"

report "done"
