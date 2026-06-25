# Acurast Example App: Tunnel (Node.js)

This example deploys two small HTTP servers inside an Acurast Node.js deployment and exposes both to the public internet via the Acurast Tunnel's **two connections**:

- **Primary** connection (Let's Encrypt cert) → an HTTP server on `127.0.0.1:8080`.
- **Secondary** connection (self-signed cert) → a second HTTP server on `127.0.0.1:8081`.

Each server responds with a `Hello from the <connection> connection: <tunnel info JSON>` page so you can quickly verify the tunnel end-to-end. The processor opens the secondary connection automatically; the deployment only chooses which local port each connection forwards to — `LOCAL_ADDRESS` for the primary, `SECONDARY_LOCAL_ADDRESS` for the secondary.

The deployment runs with `numberOfReplicas: 2`, so two processors pick up the job concurrently. To avoid both racing for the same ACME certificate, the project uses a P2P-based leader election (`TunnelCoordinator` in `src/coordinator.ts`) so only one processor at a time owns the tunnel identity.

## What it does

1. Connects to the Acurast P2P network to elect a leader among the assigned processors.
2. The leader generates a P-256 identity, calls `_STD_.tunnel.start(...)`, and broadcasts the resulting certificate to followers.
3. Followers wait for the leader's broadcast, then call `_STD_.tunnel.start(...)` with the same identity + certificate so each replica serves the same public URL.
4. The leader calls `_STD_.tunnel.start(...)` with `localAddr` (primary) and `secondaryLocalAddr` (secondary). The processor opens both tunnel connections and returns the primary and secondary public URLs.
5. Once the tunnel is up, an HTTP server listens on each local port. Any inbound HTTPS request to `https://<clientId>.<DOMAIN_SUFFIX>` is forwarded to the primary server, and any request to `https://<secondaryClientId>.<DOMAIN_SUFFIX>` to the secondary server.

Full tunnel docs: **[Tunnel Quick Start](https://docs.acurast.com/developers/getting-started/quickstart-tunnel)** + **[Node.js Tunnel API](https://docs.acurast.com/developers/build/nodejs-runtime-environment#tunnel)**.

## Configure

### `src/environment.ts` — code-side constants

| Constant | Purpose | Example |
| --- | --- | --- |
| `NETWORKS` | Per-network `tunnelRelays` + `rpcEndpoints`, keyed by `canary` / `mainnet`. The set matching the `NETWORK` env var is selected at runtime by `requireNetworkConfig()`. `rpcEndpoints` are used to look up the assigned processor set during leader election. | `{ canary: {...}, mainnet: {...} }` |
| `LOCAL_ADDRESS` | Local `host:port` the primary HTTP server binds to; the **primary** (ACME) connection forwards here. Any unprivileged port works. | `'127.0.0.1:8080'` |
| `SECONDARY_LOCAL_ADDRESS` | Local `host:port` the secondary HTTP server binds to; the **secondary** (self-signed) connection forwards here. | `'127.0.0.1:8081'` |
| `ACME_STAGING` | Issue staging Let's Encrypt certificates. Set to `false` for production deployments. | `true` |
| `P2P_RELAYS` | Acurast P2P relayer multiaddrs, used by the coordinator for leader election.

### `.env` — deployment secrets

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `ACURAST_MNEMONIC` | yes | Your deployer's seed phrase. Used by the CLI to sign the on-chain deployment extrinsic. **Do not commit this file.** |
| `NETWORK` | yes | Target network: `canary` or `mainnet`. Selects the tunnel relays and chain RPC at runtime (via the `NETWORKS` map). **Must match the `network` field in `acurast.json`** — the CLI does not read this variable. |
| `DOMAIN_SUFFIX_CANARY` / `DOMAIN_SUFFIX_MAINNET` | active one | **Your own domain suffix**, one name per network. The DNS suffix you control where the wildcard `*` and `_acu` TXT records have been published (see Quick Start step 2). Set only the one matching `NETWORK`; that same var must be the one listed in `acurast.json`'s `includeEnvironmentVariables` (the CLI rejects empty forwarded vars, so the inactive one is not listed). |
| `CALLBACK_URL` | no | Webhook URL that receives JSON events (`started`, `error`) during the deployment lifecycle. Useful for grabbing the tunnel URL. |

### `acurast.json` — deployment config

The default config targets Canary with two replicas (`numberOfReplicas: 2`). Adjust `network`, replica count, execution duration, and reward as needed. See **[Deployment Config](https://docs.acurast.com/developers/build/deployment-config)** for the full field reference.

## Development

### Setup

```bash
npm install
```

### Deploy

```bash
npm run deploy
```

This runs `npm run bundle` then `acurast deploy`, which registers the deployment on chain.

### Verify

If `CALLBACK_URL` is set, the deployment POSTs a `started` event once the tunnel is up:

```json
{
  "event": "started",
  "data": {
    "url": "https://<clientId>.<DOMAIN_SUFFIX>",
    "clientId": "<clientId>",
    "secondaryUrl": "https://<secondaryClientId>.<DOMAIN_SUFFIX>",
    "secondaryClientId": "<secondaryClientId>"
  }
}
```

Then hit the tunnel:

```bash
# Primary connection (Let's Encrypt cert).
curl https://<clientId>.<DOMAIN_SUFFIX>

# Secondary connection (self-signed cert — skip verification with -k).
curl -k https://<secondaryClientId>.<DOMAIN_SUFFIX>
```

> With `ACME_STAGING = true` the primary cert is issued by Let's Encrypt staging and is not browser-trusted either, so add `-k` to the primary `curl` too. Set `ACME_STAGING = false` for a production-trusted primary cert.
