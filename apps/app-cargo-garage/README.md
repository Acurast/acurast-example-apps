# Acurast Example App: Garage S3 (Cargo)

Runs a single-node [Garage](https://garagehq.deuxfleurs.fr) S3-compatible object
store inside an Acurast Cargo deployment and exposes it over the Acurast Tunnel's
**two connections**:

- **Primary** connection (Let's Encrypt cert) → the **S3 API** (`3900`), usable
  by any S3 client with a valid cert at `https://<clientId>.<DOMAIN_SUFFIX>`
  (path-style, region `garage`).
- **Secondary** connection (self-signed cert) →
  [Dropbear](https://github.com/mkj/dropbear) SSH server (`2222`), for shell
  access to the deployment.

## How it works

`start.sh` runs in two phases so the deployment is debuggable even if the heavy
setup stalls:

1. **Phase 1 (SSH first):** installs minimal deps (`dropbear`, `python3`,
   `python3-cryptography`, build tools, `openssl`), builds the `getifaddrs` shim
   (see [PRoot Quirks](https://docs.acurast.com/developers/build/cargo-runtime-environment#proot-quirks)),
   sets the root password (from `SSH_PASSWORD`, default `password`), starts
   `dropbear` on `127.0.0.1:2222`, then launches `tunnel.py`. SSH (the secondary
   connection) is reachable from this point on.
2. **Phase 2 (Garage):** downloads the static Garage binary, writes a single-node
   `garage.toml` (`replication_factor = 1`), starts the server, applies a
   one-node cluster layout, creates a bucket (`GARAGE_BUCKET`) and an access key,
   and starts the S3 API on `127.0.0.1:3900`. If anything here fails or hangs, it
   reports the error and **keeps SSH + the tunnel alive** so you can SSH in and
   debug (check `/tmp/garage.log`).

The generated S3 credentials are POSTed to `CALLBACK_URL` as a `credentials`
event; `tunnel.py` POSTs the public S3 URL and SSH connect command as a
`started` event.

## Use it

Combine the two callback events:

```json
{ "event": "started", "url": "https://<clientId>.<DOMAIN_SUFFIX>",
  "sshUrl": "https://<secondaryClientId>.<DOMAIN_SUFFIX>", "sshPort": 2222,
  "connect": "ssh -o ProxyCommand='openssl s_client …' root@<secondaryClientId>" }
{ "event": "credentials", "region": "garage", "bucket": "bucket",
  "accessKeyId": "GK…", "secretAccessKey": "…" }
```

Then point any S3 client at it (path-style):

```bash
aws --endpoint-url https://<clientId>.<DOMAIN_SUFFIX> \
  --region garage s3 ls s3://bucket/

aws --endpoint-url https://<clientId>.<DOMAIN_SUFFIX> \
  --region garage s3 cp ./file.txt s3://bucket/
```

(Export the reported `accessKeyId`/`secretAccessKey` as
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` first.)

For shell access, run the `connect` command from the `started` event (SSH rides
the self-signed secondary connection — `openssl s_client` does not verify the cert):

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
| `DOMAIN_SUFFIX_CANARY` / `DOMAIN_SUFFIX_MAINNET` | active one | Your tunnel DNS suffix (wildcard `*` + `_acu` TXT records published), one per network. Set only the one matching `NETWORK`. |
| `SSH_PASSWORD` | no (default `password`) | Root password for the dropbear SSH session. **Set a strong value.** |
| `CALLBACK_URL` | no | Webhook for `log`/`started`/`error`/`credentials` events. |
| `GARAGE_BUCKET` | no (default `bucket`) | Bucket created on first start. |

## Deploy

```bash
npm i
npm run deploy
```

## Notes

- Stored objects live in the processor's ephemeral storage and are **lost when
  the deployment ends** — disposable/demo storage, not durable.
- The S3 API is reachable by anyone who has the tunnel URL **and** the generated
  keys; treat the `credentials` event as a secret.
- If `tunnel.py` logs "No secondary tunnel returned", the processor build predates
  `secondaryLocalAddr` support; SSH won't be reachable (the S3 API still works).
- **Untested live** — Garage's binary download URL and the layout/key commands
  are the likely hot spots; the `error` callback will show where it stops, and
  SSH stays up for debugging.
- Pin a different release via `GARAGE_VERSION` in `start.sh`.
