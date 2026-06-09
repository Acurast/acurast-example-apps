#!/bin/sh

send_callback() {
    if [ -z "$CALLBACK_URL" ]; then
        return
    fi
    curl -s -X POST "$CALLBACK_URL" \
        -H "Content-Type: application/json" \
        -d "$1"
}

report_started() {
    # $1 = full tunnel URL (clientId.domainSuffix:port), $2 = local llama-server port
    send_callback "{\"event\":\"started\",\"url\":\"${1}\",\"port\":${2}}"
}

report_error() {
    send_callback "{\"event\":\"error\",\"message\":\"${1}\"}"
}

send_log() {
    send_callback "{\"event\":\"log\",\"message\":\"${1}\"}"
}
