# Acurast Example App: Postgres (Cargo)

Runs a [PostgreSQL](https://www.postgresql.org) database inside an Acurast Cargo
deployment and exposes it over the Acurast Tunnel's **two connections**:

- **Primary** connection (Let's Encrypt cert) → a **browser SQL console**
  (`app/webadmin.py`, `127.0.0.1:8080`), openable in any browser with a valid cert.
- **Secondary** connection (self-signed cert) →
  [Dropbear](https://github.com/mkj/dropbear) SSH server (`127.0.0.1:2222`) for
  shell access or native `psql` via an SSH local-forward of port `5432`.

Postgres itself listens on `127.0.0.1:5432` only — it is **never** directly
reachable; both paths reach it from inside the deployment.

> ⚠ **The web console has NO authentication and runs arbitrary SQL.** Anyone with
> the tunnel URL has full access to the database. It is meant for disposable/test
> databases only — do not put anything sensitive behind it. The UI shows a
> permanent insecure-mode banner. (SSH access is gated by `SSH_PASSWORD`.)

## What it does

`start.sh` runs in two phases so the deployment is debuggable even if the heavy
install stalls:

1. **Phase 1 (SSH first):** installs minimal deps (`dropbear`, `python3`,
   `python3-cryptography`, build tools), builds the `getifaddrs` shim (see
   [PRoot Quirks](https://docs.acurast.com/developers/build/cargo-runtime-environment#proot-quirks)),
   sets the root password (from `SSH_PASSWORD`, default `password`), starts
   `dropbear` on `127.0.0.1:2222`, then launches `tunnel.py`. SSH (the secondary
   connection) is reachable from this point on.
2. **Phase 2 (Postgres):** installs `postgresql`, builds the SysV-shm shim,
   initializes the data directory (superuser `POSTGRES_USER` / `POSTGRES_PASSWORD`),
   starts Postgres on `127.0.0.1:5432`, creates `POSTGRES_DB`, and starts the web
   SQL console on `127.0.0.1:8080`. If anything here fails or hangs, the script
   reports the error and **keeps SSH + the tunnel alive** so you can SSH in and
   debug (check `/tmp/postgres.log`, `/tmp/initdb.log`).

`tunnel.py` calls `tunnel_start` with `localAddr=127.0.0.1:8080` (web console)
and `secondaryLocalAddr=127.0.0.1:2222` (SSH), and POSTs a `started` event to
`CALLBACK_URL` (if set) with the web URL and the SSH connect command.

## Connect

### Web SQL console (primary)

Open the reported URL in a browser:

```
https://<clientId>.<DOMAIN_SUFFIX>
```

You get a SQL console where you can run arbitrary SQL, browse user tables, and
read/write data. It talks to Postgres over the local trust socket, so no Postgres
password is needed in the browser. **There is no auth on the console itself** —
see the security note above.

### Native `psql` over SSH (secondary)

SSH rides the secondary (self-signed) connection — `openssl s_client` in the
`ProxyCommand` does not verify the cert. The `started` event carries two
commands: `connect` (interactive shell, for debugging a failed deployment) and
`forward` (local-forwards `5432` for native `psql`).

Shell in to debug (`connect`):

```bash
ssh -o ProxyCommand='openssl s_client -quiet \
    -servername <secondaryClientId>.<DOMAIN_SUFFIX> \
    -connect <secondaryClientId>.<DOMAIN_SUFFIX>:443' \
  root@<secondaryClientId>
```

Native `psql` via local-forward (`forward`):

```bash
ssh -N -L 5432:127.0.0.1:5432 \
  -o ProxyCommand='openssl s_client -quiet \
    -servername <secondaryClientId>.<DOMAIN_SUFFIX> \
    -connect <secondaryClientId>.<DOMAIN_SUFFIX>:443' \
  root@<secondaryClientId>
# then, in another terminal:
psql -h 127.0.0.1 -p 5432 -U <POSTGRES_USER> -d <POSTGRES_DB>
```

> **Do not add `-N`** to the shell command — `-N` suppresses the remote shell, so
> the session only forwards ports and looks like it hangs after the password.

Full tunnel docs: **[Tunnel Quick Start](https://docs.acurast.com/developers/getting-started/quickstart-tunnel)** + **[Cargo Tunnel API](https://docs.acurast.com/developers/build/cargo-runtime-environment#tunnel)**.

## Configure

### `app/tunnel.py` — code-side constants

| Constant | Purpose | Example |
| --- | --- | --- |
| `NETWORKS` | Per-network tunnel relay endpoints, keyed by `canary` / `mainnet`. The set matching the `NETWORK` env var is used at runtime. | `{ "canary": {...}, "mainnet": {...} }` |
| `WEB_PORT` | Local port the web SQL console listens on; the **primary** (ACME) tunnel forwards here. Must be >= 1024. | `8080` |
| `SSH_PORT` | Local port dropbear listens on; the **secondary** (self-signed) tunnel forwards here. Must be >= 1024. | `2222` |
| `PG_PORT` | Postgres port, local-forwarded over SSH for native `psql`. | `5432` |
| `LOCAL_ADDR` / `SECONDARY_LOCAL_ADDR` | Primary (web) and secondary (SSH) tunnel targets. | `"127.0.0.1:8080"` / `"127.0.0.1:2222"` |

### `.env` — deployment secrets

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `ACURAST_MNEMONIC` | yes | Deployer seed phrase. **Do not commit.** |
| `SSH_PASSWORD` | no (default `password`) | Root password for the dropbear SSH session. **Set a strong value.** |
| `NETWORK` | yes | Target network: `canary` or `mainnet`. Selects the tunnel relays at runtime. Must match the `network` field in `acurast.json`. |
| `DOMAIN_SUFFIX_CANARY` / `DOMAIN_SUFFIX_MAINNET` | active one | Your tunnel DNS suffix (wildcard `*` + `_acu` TXT records published), one per network. Set only the one matching `NETWORK`. |
| `CALLBACK_URL` | no | Webhook for `log`/`started`/`error` events (carries the web URL and SSH connect command). |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | no (defaults) | Postgres superuser, password (for TCP/scram), and database created on first start. **Set strong values.** |

### `acurast.json` — deployment config

The default config targets one replica (`numberOfReplicas: 1`) and a 2-hour
execution window. See **[Deployment Config](https://docs.acurast.com/developers/build/deployment-config)** for the full field reference.

## Deploy

```bash
npm i
npm run deploy
```

### Verify

Tail your `CALLBACK_URL` webhook (or deployment logs) for the `started` event:

```json
{
  "event": "started",
  "url": "https://<clientId>.<DOMAIN_SUFFIX>",
  "sshUrl": "https://<secondaryClientId>.<DOMAIN_SUFFIX>",
  "sshPort": 2222,
  "connect": "ssh -o ProxyCommand='openssl s_client …' root@<secondaryClientId>",
  "forward": "ssh -N -L 5432:127.0.0.1:5432 -o ProxyCommand='openssl s_client …' root@<secondaryClientId>"
}
```

Open `url` in a browser for the SQL console; run `connect` for a debug shell or
`forward` for native `psql`.

## Notes

- The database lives in the processor's ephemeral storage and is **lost when the
  deployment ends**. Disposable/test databases only, not durable storage.
- Local Postgres connections use `trust` auth (unix socket); TCP connections
  require `scram-sha-256`. Both `SSH_PASSWORD` and `POSTGRES_PASSWORD` default to
  insecure values — set strong values before deploying anything sensitive.
- If `tunnel.py` logs "No secondary tunnel returned", the processor build predates
  `secondaryLocalAddr` support; SSH won't be reachable (the web console still works).
