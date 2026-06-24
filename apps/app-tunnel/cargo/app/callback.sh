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
    # $1 = web (primary) tunnel URL, $2 = ssh (secondary) tunnel URL, $3 = local ssh port
    # The `started` event is normally emitted by tunnel.py; this shell helper mirrors its shape.
    send_callback "{\"event\":\"started\",\"webUrl\":\"${1}\",\"sshUrl\":\"${2}\",\"sshPort\":${3}}"
}

report_error() {
    send_callback "{\"event\":\"error\",\"message\":\"${1}\"}"
}

send_log() {
    send_callback "{\"event\":\"log\",\"message\":\"${1}\"}"
}
