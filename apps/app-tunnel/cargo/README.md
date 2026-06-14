# Acurast Example App: Tunnel (Cargo)

This example runs two services inside an Acurast Cargo deployment and exposes both to the
public internet via the Acurast Tunnel's **two connections**:

- **Primary** connection (Let's Encrypt cert) → a simple **web page**, openable in any browser.
- **Secondary** connection (self-signed cert) → a [Dropbear](https://github.com/mkj/dropbear)
  **SSH server**, reached over an HTTPS-wrapped TCP connection.

The processor opens the secondary connection automatically; the deployment only chooses which
local port each connection forwards to — `localAddr` for the web page, `secondaryLocalAddr` for SSH.

## What it does

1. `start.sh` runs as the deployment entrypoint for the Cargo deployment.
2. It installs `dropbear`, `python3`, `python3-cryptography`, and `curl`, then builds a small `getifaddrs` shim (see [PRoot Quirks](https://docs.acurast.com/developers/build/cargo-runtime-environment#proot-quirks)).
3. Sets the root password (from `SSH_PASSWORD`, default `password`), generates dropbear host keys, and starts `dropbear` on `127.0.0.1:2222`.
4. Starts a static web server (`python3 -m http.server`) serving `app/www/` on `127.0.0.1:8080`.
5. Launches `tunnel.py`, which generates a P-256 identity key and calls the `tunnel_start` JSON-RPC method on the bridge socket with `localAddr=127.0.0.1:8080` (web) and `secondaryLocalAddr=127.0.0.1:2222` (SSH). The processor opens both tunnel connections and reports the public URLs.
6. The script POSTs a `started` event to `CALLBACK_URL` (if set) with the web URL and the SSH connect command so you don't have to chase logs to find them.

Once the tunnel is up:

- Open the **web URL** (primary, `https://<clientId>.<DOMAIN_SUFFIX>:8443`) in a browser.
- SSH in over the **secondary** URL:

```bash
ssh -o ProxyCommand='openssl s_client -quiet \
  -servername <secondaryClientId>.<DOMAIN_SUFFIX> \
  -connect <secondaryClientId>.<DOMAIN_SUFFIX>:8443' \
  root@<secondaryClientId>
```

Full tunnel docs: **[Tunnel Quick Start](https://docs.acurast.com/developers/getting-started/quickstart-tunnel)** + **[Cargo Tunnel API](https://docs.acurast.com/developers/build/cargo-runtime-environment#tunnel)**.

## Configure

### `app/tunnel.py` — code-side constants

| Constant | Purpose | Example |
| --- | --- | --- |
| `TUNNEL_RELAYS` | Tunnel relay endpoints to connect to. | `["relay-2.canary.acurast.com:4433"]` |
| `DOMAIN_SUFFIX` | **Replace with your own domain suffix.** The DNS suffix you control where the wildcard `*` and `_acu` TXT records have been published (see Quick Start step 2). | `"tunnel.example.com"` |
| `WEB_PORT` | Local port the web server listens on; the **primary** (ACME) tunnel forwards here. Must be >= 1024 (privileged ports can't be bound inside the proot sandbox). | `8080` |
| `SSH_PORT` | Local port dropbear listens on; the **secondary** (self-signed) tunnel forwards here. Must be >= 1024. | `2222` |
| `LOCAL_ADDR` | Primary tunnel target, i.e. `127.0.0.1:<WEB_PORT>` (the web page). | `"127.0.0.1:8080"` |
| `SECONDARY_LOCAL_ADDR` | Secondary tunnel target, i.e. `127.0.0.1:<SSH_PORT>` (SSH). | `"127.0.0.1:2222"` |
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
| `CALLBACK_URL` | no | Webhook URL that receives JSON events (`log`, `started`, `error`) during the deployment lifecycle. Useful for grabbing the web URL and SSH connect command. |

### `acurast.json` — deployment config

The default config targets Canary with one replica (`numberOfReplicas: 1`) and a 2-hour execution window. Adjust execution duration and reward as needed. See **[Deployment Config](https://docs.acurast.com/developers/build/deployment-config)** for the full field reference.

> **Note:** `minProcessorVersions.android` is `125` — the `secondaryLocalAddr` field requires that processor build. On a processor older than 125 the deployment won't be assigned; lower it (and drop the secondary tunnel) if you need to target older processors.

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
  "webUrl": "https://<clientId>.<DOMAIN_SUFFIX>:8443",
  "sshUrl": "https://<secondaryClientId>.<DOMAIN_SUFFIX>:8443",
  "sshPort": 2222,
  "connect": "ssh -o ProxyCommand='openssl s_client -quiet -servername …' root@<secondaryClientId>"
}
```

Open `webUrl` in a browser to see the page. Run the `connect` command and authenticate with `SSH_PASSWORD` to get a shell.
