# Acurast Example App: Tunnel (Cargo)

This example deploys a [Dropbear](https://github.com/mkj/dropbear) SSH server inside an Acurast Cargo deployment and exposes it to the public internet via the Acurast Tunnel. 
The result: an interactive SSH session into the deployment, reachable from anywhere through a single HTTPS-wrapped TCP connection.

## What it does

1. `start.sh` runs as the deployment entrypoint for the Cargo deployment.
2. It installs `dropbear`, `python3`, `python3-cryptography`, and `curl`, then builds a small `getifaddrs` shim (see [PRoot Quirks](https://docs.acurast.com/developers/build/cargo-runtime-environment#proot-quirks)).
3. Sets the root password (from `SSH_PASSWORD`, default `password`), generates dropbear host keys, and starts `dropbear` on `127.0.0.1:2222` in the foreground.
4. Launches `tunnel.py`, which generates a P-256 identity key and calls the `tunnel_start` JSON-RPC method on the bridge socket. The processor opens the reverse tunnel and reports the public URL.
5. The script POSTs a `started` event to `CALLBACK_URL` (if set) with the connect command so you don't have to chase logs to find it.

Once the tunnel is up, you SSH in via:

```bash
ssh -o ProxyCommand='openssl s_client -quiet \
  -servername <clientId>.<DOMAIN_SUFFIX> \
  -connect <clientId>.<DOMAIN_SUFFIX>:8443' \
  root@<clientId>
```

Full tunnel docs: **[Tunnel Quick Start](https://docs.acurast.com/developers/getting-started/quickstart-tunnel)** + **[Cargo Tunnel API](https://docs.acurast.com/developers/build/cargo-runtime-environment#tunnel)**.

## Configure

### `app/tunnel.py` — code-side constants

| Constant | Purpose | Example |
| --- | --- | --- |
| `TUNNEL_RELAYS` | Tunnel relay endpoints to connect to. | `["relay-2.canary.acurast.com:4433"]` |
| `DOMAIN_SUFFIX` | **Replace with your own domain suffix.** The DNS suffix you control where the wildcard `*` and `_acu` TXT records have been published (see Quick Start step 2). | `"tunnel.example.com"` |
| `SSH_PORT` | Local port dropbear listens on and the tunnel forwards to. Must be >= 1024 (privileged ports can't be bound inside the proot sandbox). | `2222` |
| `LOCAL_ADDR` | Derived from `SSH_PORT`, i.e. `127.0.0.1:<SSH_PORT>`. Edit if you want the tunnel to forward to a service other than dropbear. | `"127.0.0.1:2222"` |
| `STATUS_POLL_INTERVAL_SEC` | How often the script polls `tunnel_status` after start (just for log visibility). | `30` |

### `.env` — deployment secrets

```bash
cp .env.example .env
```

Edit it to set:

| Variable | Required | Purpose |
| --- | --- | --- |
| `ACURAST_MNEMONIC` | yes | Your deployer's seed phrase. Used by the CLI to sign the on-chain deployment extrinsic. **Do not commit.** |
| `SSH_PASSWORD` | no (defaults to `password`) | Root password for the dropbear SSH session. **Strongly recommend setting a strong value** — `password` is for testing only. |
| `CALLBACK_URL` | no | Webhook URL that receives JSON events (`log`, `started`, `error`) during the deployment lifecycle. Useful for grabbing the SSH connect command. |

### `acurast.json` — deployment config

The default config targets Canary with one replica (`numberOfReplicas: 1`) and a 2-hour execution window. Adjust execution duration and reward as needed. See **[Deployment Config](https://docs.acurast.com/developers/build/deployment-config)** for the full field reference.

## Development

### Deploy

```bash
acurast deploy
```

This uploads `app/` to IPFS and registers the deployment on-chain.

### Verify

Tail your `CALLBACK_URL` webhook (or the deployment logs) for the `started` event:

```json
{
  "event": "started",
  "url": "https://<clientId>.<DOMAIN_SUFFIX>:8443",
  "sshPort": 2222,
  "connect": "ssh -o ProxyCommand='openssl s_client -quiet -servername …' root@<clientId>"
}
```

Run the `connect` command and authenticate with `SSH_PASSWORD`.
