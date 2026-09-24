#!/bin/sh
# Fixed tunnel URL for app-cargo-laya: the relay names the tunnel after its key,
# hex(sha256(compressed P-256 public key))[0:8] (quic-tunnel/tunnel-server/src/util.rs).
#
#   tools/tunnel_key.sh           new key: prints TUNNEL_KEY=... for .env and its URL
#   tools/tunnel_key.sh <key>     the URL for an existing TUNNEL_KEY
set -eu
SUFFIX=${DOMAIN_SUFFIX:-acu.run}
if [ $# -eq 0 ]; then
    # PKCS#8, as the processor's tunnel expects (genpkey's DER alone is SEC1).
    KEY=$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -outform DER \
        | openssl pkcs8 -topk8 -nocrypt -inform DER -outform DER | base64 | tr -d '\n')
    echo "TUNNEL_KEY=$KEY"
else
    KEY=$1
fi
# The last 33 bytes of the public key in SubjectPublicKeyInfo DER are the compressed point.
ID=$(printf '%s' "$KEY" | base64 -d | openssl pkey -inform DER -pubout -outform DER -ec_conv_form compressed \
    | tail -c 33 | openssl dgst -sha256 -binary | head -c 8 | xxd -p)
echo "URL: https://$ID.$SUFFIX"
