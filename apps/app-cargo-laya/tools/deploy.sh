#!/bin/sh
# Deploy N single-phone instances of cargo-laya, each with its own fixed tunnel URL.
#
#   tools/deploy.sh <instances> <days> [--min-cpu N] [--min-cpu-multi N] [--acu-per-day X] [--wait]
#
# Prints a JSON array on stdout, one entry per instance:
#   [{"instance": 1, "deployment_id": "175212", "url": "https://<id>.acu.run",
#     "registered_s": 38, "acknowledged_s": 81, "ready_s": 284}, ...]
# (ready_s, the time until /health reports the model loaded, only with --wait.)
# Progress goes to stderr. Each instance's TUNNEL_KEY is appended to
# .acurast/tunnel-keys.env (secret; redeploying with the same key keeps the URL).
#
# Every instance is one `acurast deploy` with numberOfReplicas 1, because replicas of one
# deployment share TUNNEL_KEY and would fight over one URL. The deploys run one after
# another from the same account, in a temporary copy of the project, so acurast.json and
# .env here stay untouched. --min-cpu / --min-cpu-multi are the CLI's benchmark filters
# (on-chain single- and multi-core CPU score; fast phones score about 1.5-2e8 single-core).
set -eu

usage() { sed -n '2,4p' "$0" | cut -c3- >&2; exit 1; }
[ $# -ge 2 ] || usage
N=$1 DAYS=$2; shift 2
PER_DAY=0.8 WAIT= FILTERS=
while [ $# -gt 0 ]; do
    case $1 in
        --min-cpu) FILTERS="$FILTERS --min-cpu-score $2"; shift 2 ;;
        --min-cpu-multi) FILTERS="$FILTERS --min-cpu-multi-score $2"; shift 2 ;;
        --acu-per-day) PER_DAY=$2; shift 2 ;;
        --wait) WAIT=1; shift ;;
        *) usage ;;
    esac
done

ROOT=$(cd "$(dirname "$0")/.." && pwd)
KEYS="$ROOT/.acurast/tunnel-keys.env"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/cargo-laya-deploy.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
log() { echo "[$(date +%H:%M:%S)] $*" >&2; }

# Temporary project: this app, the .env, and acurast.json with 1 replica, the duration and the price.
cp -R "$ROOT/app" "$ROOT/.env" "$WORK/"
node -e '
const fs = require("fs"), [src, dst, days, perDay] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(src)), c = config.projects["cargo-laya"];
c.numberOfReplicas = 1;
c.execution = { type: "onetime", maxExecutionTimeInMs: Math.round(days * 86400000) };
c.maxCostPerExecution = Math.round(days * perDay * 1e12);
fs.writeFileSync(dst, JSON.stringify(config, null, 2));
' "$ROOT/acurast.json" "$WORK/acurast.json" "$DAYS" "$PER_DAY"
mkdir -p "$ROOT/.acurast"
log "$N instance(s), $DAYS days, max $(awk "BEGIN{print $DAYS * $PER_DAY}") ACU each$FILTERS"

# Waits until an instance serves the loaded model (max 1 h) and records the seconds.
wait_ready() {
    while [ $(( $(date +%s) - $2 )) -lt 3600 ]; do
        if curl -s -m 8 "$1/health" | grep -q '"status": *"ok"'; then
            echo $(( $(date +%s) - $2 )) > "$3"; log "$1 ready after $(cat "$3") s"; return
        fi
        sleep 10
    done
}

i=1
while [ "$i" -le "$N" ]; do
    OUT=$("$ROOT/tools/tunnel_key.sh")
    KEY=$(echo "$OUT" | sed -n 's/^TUNNEL_KEY=//p') URL=$(echo "$OUT" | sed -n 's/^URL: //p')
    START=$(date +%s)
    echo "$URL" > "$WORK/$i.url"
    log "instance $i: deploying, url $URL"
    [ -z "$WAIT" ] || wait_ready "$URL" "$START" "$WORK/$i.ready" &
    # The CLI's dotenv does not override the process env, so TUNNEL_KEY here wins over .env.
    # shellcheck disable=SC2086
    (cd "$WORK" && TUNNEL_KEY=$KEY acurast deploy --non-interactive --exit-early -o json $FILTERS 2>&1) |
    while IFS= read -r line; do
        case $line in
            *'"status":"WaitingForMatch"'*)
                echo "$line" | sed -n 's/.*"jobIds":\[\[[^]]*,\([0-9]*\)\].*/\1/p; s/.*"jobIds":\[\([0-9]*\)[],].*/\1/p' > "$WORK/$i.id"
                echo $(( $(date +%s) - START )) > "$WORK/$i.registered"
                log "instance $i registered as $(cat "$WORK/$i.id") after $(cat "$WORK/$i.registered") s" ;;
            *'"status":"EnvironmentVariablesSet"'*)
                echo $(( $(date +%s) - START )) > "$WORK/$i.acknowledged"
                log "instance $i acknowledged, env set after $(cat "$WORK/$i.acknowledged") s" ;;
            ?*) echo "$line" > "$WORK/$i.last" ;;
        esac
    done
    [ -f "$WORK/$i.acknowledged" ] || log "instance $i failed: $(cut -c1-300 "$WORK/$i.last" 2>/dev/null)"
    printf '# %s deployment %s %s\nTUNNEL_KEY=%s\n' "$(date '+%Y-%m-%d %H:%M')" \
        "$(cat "$WORK/$i.id" 2>/dev/null || echo none)" "$URL" "$KEY" >> "$KEYS"
    i=$((i + 1))
done
wait

# The result: one JSON object per instance, missing values as null.
num() { cat "$1" 2>/dev/null || echo null; }
i=1; echo "["
while [ "$i" -le "$N" ]; do
    ID=null; [ -s "$WORK/$i.id" ] && ID="\"$(cat "$WORK/$i.id")\""
    printf '  {"instance": %s, "deployment_id": %s, "url": "%s", "registered_s": %s, "acknowledged_s": %s, "ready_s": %s}' \
        "$i" "$ID" "$(cat "$WORK/$i.url")" \
        "$(num "$WORK/$i.registered")" "$(num "$WORK/$i.acknowledged")" "$(num "$WORK/$i.ready")"
    [ "$i" -lt "$N" ] && echo "," || echo
    i=$((i + 1))
done
echo "]"
