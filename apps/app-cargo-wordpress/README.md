# Acurast Example App: WordPress (Cargo)

> 📖 **Docs / full walkthrough:** [Host a WordPress Site on Acurast](https://docs.acurast.com/developers/examples/wordpress)

Runs a full [WordPress](https://wordpress.org) site (Apache + PHP + MariaDB)
inside an Acurast Cargo deployment and exposes it over the Acurast Tunnel's
**two connections**:

- **Primary** connection (Let's Encrypt cert) → Apache / WordPress, openable in
  any browser at `https://<clientId>.<DOMAIN_SUFFIX>` with a valid cert.
- **Secondary** connection (self-signed cert) →
  [Dropbear](https://github.com/mkj/dropbear) SSH server, for shell access to
  the deployment (reached over an HTTPS-wrapped TCP connection).

The processor opens the secondary connection automatically; the deployment only
chooses which local port each connection forwards to — `localAddr` for
WordPress, `secondaryLocalAddr` for SSH.

## How it works

1. `start.sh` installs Apache, PHP, MariaDB, and dropbear, and builds the
   `getifaddrs` shim (see [PRoot Quirks](https://docs.acurast.com/developers/build/cargo-runtime-environment#proot-quirks)).
2. MariaDB is initialized and started directly (no systemd in the rootfs); the
   `WORDPRESS_DB_*` database and user are created.
3. WordPress core is downloaded to `/var/www/html`; `wp-config.php` takes its DB
   creds from the env and derives `WP_HOME`/`WP_SITEURL` from the request host
   so it works at whatever tunnel URL it lands on. Salts are fetched fresh.
4. Apache listens on `127.0.0.1:8080`; dropbear listens on `127.0.0.1:2222`
   (root password from `SSH_PASSWORD`, default `password`).
5. `tunnel.py` calls `tunnel_start` with `localAddr=127.0.0.1:8080` (WordPress)
   and `secondaryLocalAddr=127.0.0.1:2222` (SSH), then POSTs the public URL and
   the SSH connect command to `CALLBACK_URL`.

## Use it

Tail `CALLBACK_URL` for the `started` event:

```json
{
  "event": "started",
  "url": "https://<clientId>.<DOMAIN_SUFFIX>",
  "sshUrl": "https://<secondaryClientId>.<DOMAIN_SUFFIX>",
  "sshPort": 2222,
  "connect": "ssh -o ProxyCommand='openssl s_client -quiet -servername …' root@<secondaryClientId>"
}
```

Open `url` — you'll land on the WordPress install wizard. Finish setup and you
have a live site. Run the `connect` command (authenticate with `SSH_PASSWORD`)
to get a shell into the deployment:

```bash
ssh -o ProxyCommand='openssl s_client -quiet \
  -servername <secondaryClientId>.<DOMAIN_SUFFIX> \
  -connect <secondaryClientId>.<DOMAIN_SUFFIX>:443' \
  root@<secondaryClientId>
```

## Configure

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `ACURAST_MNEMONIC` | yes | Deployer seed phrase. **Do not commit.** |
| `NETWORK` | yes | Target network: `canary` or `mainnet`. Selects the tunnel relays at runtime. Must match the `network` field in `acurast.json`. |
| `DOMAIN_SUFFIX_CANARY` / `DOMAIN_SUFFIX_MAINNET` | no | **Optional** custom domain suffix, one per network. When unset, falls back to the network default (`acu.run` / `canary.acu.run`). If set, the matching var must also be listed in `acurast.json`'s `includeEnvironmentVariables`. |
| `SSH_PASSWORD` | no (default `password`) | Root password for the dropbear SSH session. **Set a strong value.** |
| `CALLBACK_URL` | no | Webhook for `log`/`started`/`error` events (carries the web URL and SSH connect command). |
| `WORDPRESS_DB_NAME` / `_USER` / `_PASSWORD` | no (defaults) | DB created on first start. **Set strong values.** |

## Deploy

```bash
npm i
npm run deploy
```

## Notes

- The database and uploads live in the processor's ephemeral storage and are
  **lost when the deployment ends**. This is a disposable/demo site, not durable
  hosting.
- TLS terminates at the Acurast relay; Apache sees plain HTTP. `wp-config.php`
  trusts `X-Forwarded-Proto` so WordPress still builds `https://` URLs.
- SSH rides the **secondary** (self-signed) connection — `openssl s_client` in
  the `ProxyCommand` does not verify that cert. If `tunnel.py` logs "No secondary
  tunnel returned", the processor build predates `secondaryLocalAddr` support and
  SSH won't be reachable (the WordPress site still works).
- **Untested live** — MariaDB init under proot is the most likely hot spot; the
  `started`/`error` callback events will show where it gets stuck.
