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

- Open the **web URL** (primary, `https://<clientId>.<DOMAIN_SUFFIX>`) in a browser. Unless a custom one is configured, `DOMAIN_SUFFIX` is `acu.run` for `mainnet` or `canary.acu.run` for `canary`.
- SSH in over the **secondary** URL:

```bash
ssh -o ProxyCommand='openssl s_client -quiet \
  -servername <secondaryClientId>.<DOMAIN_SUFFIX> \
  -connect <secondaryClientId>.<DOMAIN_SUFFIX>:8443' \
  root@<secondaryClientId>
```

Full tunnel docs: **[Tunnel Quick Start](https://docs.acurast.com/developers/getting-started/quickstart-tunnel)** and **[Cargo Tunnel API](https://docs.acurast.com/developers/build/cargo-runtime-environment#tunnel)**.

## Configure

### `app/tunnel.py` — code-side constants

| Constant | Purpose | Example |
| --- | --- | --- |
| `NETWORKS` | Per-network tunnel relay endpoints, keyed by `canary` / `mainnet`. The set matching the `NETWORK` env var is used at runtime. | `{ "canary": {...}, "mainnet": {...} }` |
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
| `NETWORK` | yes | Target network: `canary` or `mainnet`. Selects the tunnel relays at runtime (via the `NETWORKS` map). **Must match the `network` field in `acurast.json`** — the CLI does not read this variable. |
| `DOMAIN_SUFFIX_CANARY` / `DOMAIN_SUFFIX_MAINNET` | no | **Optional custom domain suffix**, one name per network. The DNS suffix you control where the wildcard `*` and `_acu` TXT records have been published (see Quick Start step 2). Set only the one matching `NETWORK`; if set, that same var must be the one listed in `acurast.json`'s `includeEnvironmentVariables` (the CLI rejects empty forwarded vars, so the inactive one is not listed). |
| `SSH_PASSWORD` | no (defaults to `password`) | Root password for the dropbear SSH session. **Strongly recommend setting a strong value** — `password` is for testing only. |
| `CALLBACK_URL` | no | Webhook URL that receives JSON events (`log`, `started`, `error`) during the deployment lifecycle. Useful for grabbing the web URL and SSH connect command. |

### `acurast.json` — deployment config

The default config targets Canary with one replica (`numberOfReplicas: 1`) and a 2-hour execution window. Adjust execution duration and reward as needed. See **[Deployment Config](https://docs.acurast.com/developers/build/deployment-config)** for the full field reference.

> **Note:** `minProcessorVersions.android` is `1.26.0`. On a processor older than version `1.26.0` the deployment won't work.

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
  "webUrl": "https://<clientId>.<DOMAIN_SUFFIX>",
  "sshUrl": "https://<secondaryClientId>.<DOMAIN_SUFFIX>",
  "sshPort": 2222,
  "connect": "ssh -o ProxyCommand='openssl s_client -quiet -servername …' root@<secondaryClientId>"
}
```

Open `webUrl` in a browser to see the page. Run the `connect` command and authenticate with `SSH_PASSWORD` to get a shell.
