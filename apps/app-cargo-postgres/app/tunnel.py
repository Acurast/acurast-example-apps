#!/usr/bin/env python3
"""Acurast reverse-tunnel client for the Postgres deployment.

Generates a P-256 identity key, then asks the Acurast Processor (via the JSON-RPC
bridge on the abstract Unix socket named in $BRIDGE_SOCKET) to open a reverse
tunnel with TWO connections: the PRIMARY (Let's Encrypt cert) forwards to the
local web SQL console so it opens in any browser with a valid cert; the
SECONDARY (self-signed) forwards to a local dropbear SSH instance for shell /
native `psql` access (via an SSH local-forward of port 5432).
"""

import base64
import json
import os
import signal
import socket
import subprocess
import sys
import time
import traceback
from urllib import request as urlrequest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

# Network-specific values. Pick the set matching $NETWORK (see .env). Keep the
# `network` field in acurast.json in sync with this — the CLI does not read $NETWORK.
NETWORKS = {
    "mainnet": {
        "relays": [
            "relay-1.mainnet.acurast.com:4433",
        ],
        "domainSuffix": "acu.run",
    },
    "canary": {
        "relays": [
            "relay-2.canary.acurast.com:4433",
            "canary-relay.5elementsnodes.com:4433",
            "relay.el9-acurast.com:4433",
            "canary-relay.vincent-acurast.xyz:4433",
            "canary-relay.acurast.online:4433",
        ],
        "domainSuffix": "canary.acu.run",
    },
}
NETWORK = os.environ.get("NETWORK")
if NETWORK not in NETWORKS:
    print(f"NETWORK env var must be one of {list(NETWORKS)}; got {NETWORK!r}.", file=sys.stderr)
    sys.exit(1)
TUNNEL_RELAYS = NETWORKS[NETWORK]["relays"]
# DNS suffix you control (wildcard `*` + `_acu` TXT records published). Optional —
# override per network via DOMAIN_SUFFIX_CANARY / DOMAIN_SUFFIX_MAINNET (see .env).
# When unset, falls back to the network default (acu.run / canary.acu.run).
_DOMAIN_ENV = f"DOMAIN_SUFFIX_{NETWORK.upper()}"
DOMAIN_SUFFIX = os.environ.get(_DOMAIN_ENV) or NETWORKS[NETWORK]["domainSuffix"]
# Primary (ACME) tunnel serves the web SQL console; secondary (self-signed) maps
# to SSH for shell / native psql access (ssh -L 5432).
WEB_PORT = int(os.environ.get("WEB_PORT", "8080"))
SSH_PORT = int(os.environ.get("SSH_PORT", "2222"))
PG_PORT = int(os.environ.get("PGPORT", "5432"))
LOCAL_ADDR = f"127.0.0.1:{WEB_PORT}"
SECONDARY_LOCAL_ADDR = f"127.0.0.1:{SSH_PORT}"
STATUS_POLL_INTERVAL_SEC = 30

CALLBACK_URL = os.environ.get("CALLBACK_URL")
BRIDGE_SOCKET = os.environ.get("BRIDGE_SOCKET")
if not BRIDGE_SOCKET:
    print("BRIDGE_SOCKET env var not set; cannot reach Acurast RPC bridge.", file=sys.stderr)
    sys.exit(1)


def post_callback(payload):
    if not CALLBACK_URL:
        return
    try:
        req = urlrequest.Request(
            CALLBACK_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urlrequest.urlopen(req, timeout=10).close()
    except Exception as e:
        print(f"callback POST failed: {e}", file=sys.stderr)


def report_log(message):
    print(message)
    post_callback({"event": "log", "message": message})


def report_started(url, ssh_url, ssh_port, connect, forward):
    post_callback({
        "event": "started",
        "url": url,
        "sshUrl": ssh_url,
        "sshPort": ssh_port,
        "connect": connect,
        "forward": forward,
    })


def report_error(message):
    print(f"ERROR: {message}", file=sys.stderr)
    post_callback({"event": "error", "message": message})


_rpc_id = 0


def _next_id():
    global _rpc_id
    _rpc_id += 1
    return _rpc_id


def rpc_call(method, params):
    """One-shot JSON-RPC 2.0 call.

    The host treats each socket as a single request/response exchange
    (BridgeConnection.kt), so a fresh connection is opened per call.
    """
    req = {"jsonrpc": "2.0", "method": method, "params": params, "id": _next_id()}
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        # Abstract namespace: leading NUL byte, no filesystem entry.
        sock.connect("\0" + BRIDGE_SOCKET)
        sock.sendall((json.dumps(req) + "\n").encode("utf-8"))
        buf = bytearray()
        while b"\n" not in buf:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buf.extend(chunk)
    finally:
        sock.close()
    line = bytes(buf).split(b"\n", 1)[0].decode("utf-8")
    resp = json.loads(line)
    if "error" in resp:
        e = resp["error"]
        raise RuntimeError(f"RPC error {e.get('code')}: {e.get('message')}")
    return resp.get("result")


def generate_tunnel_identity_pkcs8_b64():
    """P-256 keypair as base64-encoded PKCS#8 DER (NO_WRAP).

    Required by TunnelSpec.primaryKey.bytes.
    """
    key = ec.generate_private_key(ec.SECP256R1())
    pkcs8 = key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return base64.b64encode(pkcs8).decode("ascii")


def main():
    key_b64 = generate_tunnel_identity_pkcs8_b64()
    spec = {
        "serverAddrs": TUNNEL_RELAYS,
        "domainSuffix": DOMAIN_SUFFIX,
        # Primary (ACME) connection forwards here — the web SQL console.
        "localAddr": LOCAL_ADDR,
        # Secondary (self-signed) connection forwards here — the SSH server. The
        # host opens the secondary connection automatically; we only choose its target.
        "secondaryLocalAddr": SECONDARY_LOCAL_ADDR,
        "primaryKey": {"algorithm": "Secp256r1", "bytes": key_b64},
        "acmeStaging": False,
    }

    report_log(f"Requesting reverse tunnel (web -> {LOCAL_ADDR}, ssh -> {SECONDARY_LOCAL_ADDR})")
    info = rpc_call("tunnel_start", [spec])
    url = info.get("url")
    client_id = info.get("clientId")
    web_url = url or f"https://{client_id}.{DOMAIN_SUFFIX}:8443"
    ssh_url = info.get("secondaryUrl")
    ssh_client_id = info.get("secondaryClientId")
    report_log(f"Tunnel started: web url={web_url} clientId={client_id}")

    if not ssh_client_id:
        report_error(
            "No secondary tunnel returned — the processor build may predate "
            "secondaryLocalAddr support; SSH / native psql access will not be reachable."
        )
        connect_cmd = None
        forward_cmd = None
    else:
        report_log(f"SSH tunnel ready: url={ssh_url} secondaryClientId={ssh_client_id}")
        # SSH rides the self-signed secondary connection; openssl s_client does not
        # verify the cert. `connect_cmd` opens an interactive shell (use this to
        # debug a failed deployment); `forward_cmd` adds a local-forward of 5432 so
        # a native psql connects to 127.0.0.1. Note: NO -N on the shell command —
        # -N suppresses the shell, so it only forwards ports and looks like it hangs.
        proxy = (
            f"-o ProxyCommand='openssl s_client -quiet "
            f"-servername {ssh_client_id}.{DOMAIN_SUFFIX} "
            f"-connect {ssh_client_id}.{DOMAIN_SUFFIX}:443'"
        )
        connect_cmd = f"ssh {proxy} root@{ssh_client_id}"
        forward_cmd = f"ssh -N -L {PG_PORT}:127.0.0.1:{PG_PORT} {proxy} root@{ssh_client_id}"

    report_started(web_url, ssh_url, SSH_PORT, connect_cmd, forward_cmd)
    print(f"Open the web SQL console:\n  {web_url}")
    if connect_cmd:
        print(f"SSH shell (debug):\n  {connect_cmd}")
        print(f"Native psql via SSH local-forward:\n  {forward_cmd}")

    stop_called = {"value": False}

    def shutdown(signum, _frame):
        if stop_called["value"]:
            sys.exit(0)
        stop_called["value"] = True
        report_log(f"Received signal {signum}, stopping tunnel")
        try:
            rpc_call("tunnel_stop", [])
        except Exception as e:
            print(f"tunnel_stop failed: {e}", file=sys.stderr)
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    status_names = {0: "Starting", 1: "Running", 2: "Stopped", 3: "Failed", -1: "None"}
    while True:
        time.sleep(STATUS_POLL_INTERVAL_SEC)
        try:
            res = rpc_call("tunnel_status", [])
            s = res.get("status", -1) if isinstance(res, dict) else -1
            print(f"tunnel status: {status_names.get(s, s)}")
        except Exception as e:
            print(f"status poll failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        traceback.print_exc()
        report_error(str(e))
        sys.exit(1)
