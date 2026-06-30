#!/usr/bin/env python3
"""Acurast reverse-tunnel client for the Cargo Hermes deployment.

Generates a P-256 identity key, then asks the Acurast Processor (via the JSON-RPC
bridge on the abstract Unix socket named in $BRIDGE_SOCKET) to open a reverse
tunnel with TWO connections: the PRIMARY (Let's Encrypt cert) forwards to the
local Hermes WebUI (plain HTTP, so the tunnel URL opens directly in a browser);
the SECONDARY (self-signed) forwards to a local dropbear SSH instance for the
`hermes` CLI and debugging.
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
    },
    "canary": {
        "relays": [
            "relay-2.canary.acurast.com:4433",
            "canary-relay.5elementsnodes.com:4433",
            "acurast-canary-relay.dishich.com:4433",
            "relay.el9-acurast.com:4433",
            "canary-relay.vincent-acurast.xyz:4433",
            "canary-relay.acurast.online:4433",
        ],
    },
}
NETWORK = os.environ.get("NETWORK")
if NETWORK not in NETWORKS:
    print(f"NETWORK env var must be one of {list(NETWORKS)}; got {NETWORK!r}.", file=sys.stderr)
    sys.exit(1)
TUNNEL_RELAYS = NETWORKS[NETWORK]["relays"]
# DNS suffix you control (wildcard `*` + `_acu` TXT records published). One name
# per network — DOMAIN_SUFFIX_CANARY / DOMAIN_SUFFIX_MAINNET (see .env) — but only
# the one matching $NETWORK needs to be set. Required.
_DOMAIN_ENV = f"DOMAIN_SUFFIX_{NETWORK.upper()}"
DOMAIN_SUFFIX = os.environ.get(_DOMAIN_ENV)
if not DOMAIN_SUFFIX:
    print(f"{_DOMAIN_ENV} env var not set; cannot start tunnel without a domain suffix.", file=sys.stderr)
    sys.exit(1)
# Primary (ACME) tunnel serves the Hermes WebUI; secondary (self-signed) maps to SSH.
WEBUI_PORT = int(os.environ.get("HERMES_WEBUI_PORT", "8787"))
SSH_PORT = int(os.environ.get("SSH_PORT", "2222"))
LOCAL_ADDR = f"127.0.0.1:{WEBUI_PORT}"
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


def report_started(url, ssh_url, ssh_port, webui_port, connect):
    post_callback({
        "event": "started",
        "url": url,
        "sshUrl": ssh_url,
        "sshPort": ssh_port,
        "webuiPort": webui_port,
        "connect": connect,
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
        # Primary (ACME) connection forwards here — the Hermes WebUI (HTTP).
        "localAddr": LOCAL_ADDR,
        # Secondary (self-signed) connection forwards here — the SSH server. The
        # host opens the secondary connection automatically; we only choose its target.
        "secondaryLocalAddr": SECONDARY_LOCAL_ADDR,
        "primaryKey": {"algorithm": "Secp256r1", "bytes": key_b64},
        "acmeStaging": False,
    }

    report_log(f"Requesting reverse tunnel (webui -> {LOCAL_ADDR}, ssh -> {SECONDARY_LOCAL_ADDR})")
    info = rpc_call("tunnel_start", [spec])
    url = info.get("url")
    client_id = info.get("clientId")
    ssh_url = info.get("secondaryUrl")
    ssh_client_id = info.get("secondaryClientId")
    report_log(f"Tunnel started: webui url={url} clientId={client_id}")

    if not ssh_client_id:
        report_error(
            "No secondary tunnel returned — the processor build may predate "
            "secondaryLocalAddr support; SSH (the `hermes` CLI + debug path) will not be reachable."
        )
        connect_cmd = None
    else:
        report_log(f"SSH tunnel ready: url={ssh_url} secondaryClientId={ssh_client_id}")
        # SSH rides the self-signed secondary connection; openssl s_client does not
        # verify the cert. Use this for the `hermes` CLI or to debug a failed start.
        connect_cmd = (
            f"ssh -o ProxyCommand='openssl s_client -quiet "
            f"-servername {ssh_client_id}.{DOMAIN_SUFFIX} "
            f"-connect {ssh_client_id}.{DOMAIN_SUFFIX}:443' root@{ssh_client_id}"
        )

    report_started(url, ssh_url, SSH_PORT, WEBUI_PORT, connect_cmd)
    print(f"Hermes WebUI (open in browser):\n  {url}")
    if connect_cmd:
        print(f"SSH shell — `hermes` CLI / debug (secondary):\n  {connect_cmd}")

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
