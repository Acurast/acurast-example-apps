#!/usr/bin/env python3
"""Acurast reverse-tunnel client for the LLM deployment.

Generates a P-256 identity key, then asks the Acurast Processor (via the JSON-RPC
bridge on the abstract Unix socket named in $BRIDGE_SOCKET) to open a
reverse tunnel forwarding inbound traffic to the local llama-server instance.
"""

import base64
import json
import os
import signal
import socket
import sys
import time
import traceback
from urllib import request as urlrequest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

TUNNEL_RELAYS = [
    "relay-2.canary.acurast.com:4433",
    "canary-relay.5elementsnodes.com:4433",
    "acurast-canary-relay.dishich.com:4433",
    "relay.el9-acurast.com:4433",
    "canary-relay.vincent-acurast.xyz:4433",
    "canary-relay.acurast.online:4433",
]
DOMAIN_SUFFIX = "tunnel.example.com"
LLAMA_PORT = 8080
LOCAL_ADDR = f"127.0.0.1:{LLAMA_PORT}"
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


def report_started(url, port):
    post_callback({"event": "started", "url": url, "port": port})


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
        "localAddr": LOCAL_ADDR,
        "primaryKey": {"algorithm": "Secp256r1", "bytes": key_b64},
        "acmeStaging": False,
    }

    report_log(f"Requesting reverse tunnel to {LOCAL_ADDR}")
    info = rpc_call("tunnel_start", [spec])
    url = info.get("url")
    client_id = info.get("clientId")
    report_log(f"Tunnel started: url={url} clientId={client_id}")
    report_started(url, LLAMA_PORT)
    print(f"llama-server reachable via tunnel:\n  {url}")

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
