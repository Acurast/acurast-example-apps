# Acurast Example App: Tunnel (Node.js)

This example deploys a small HTTP server inside an Acurast Node.js deployment and exposes it to the public internet via the Acurast Tunnel. The server responds with a `Hello from: <tunnel info JSON>` page so you can quickly verify the tunnel end-to-end.

The deployment runs with `numberOfReplicas: 2`, so two processors pick up the job concurrently. To avoid both racing for the same ACME certificate, the project uses a P2P-based leader election (`TunnelCoordinator` in `src/coordinator.ts`) so only one processor at a time owns the tunnel identity.

## What it does

1. Connects to the Acurast P2P network to elect a leader among the assigned processors.
2. The leader generates a P-256 identity, calls `_STD_.tunnel.start(...)`, and broadcasts the resulting certificate to followers.
3. Followers wait for the leader's broadcast, then call `_STD_.tunnel.start(...)` with the same identity + certificate so each replica serves the same public URL.
4. Once the tunnel is up, an HTTP server listens on `127.0.0.1:<LOCAL_ADDRESS_PORT>` and any inbound HTTPS request to `https://<clientId>.<DOMAIN_SUFFIX>:8443` is forwarded to it.

Full tunnel docs: **[Tunnel Quick Start](https://docs.acurast.com/developers/getting-started/quickstart-tunnel)** + **[Node.js Tunnel API](https://docs.acurast.com/developers/build/nodejs-runtime-environment#tunnel)**.

## Configure

### `src/environment.ts` — code-side constants

| Constant | Purpose | Example |
| --- | --- | --- |
| `TUNNEL_RELAYS` | Tunnel relay endpoints to connect to. | `['relay-2.canary.acurast.com:4433']` |
| `RPC_ENDPOINTS` | Acurast chain RPC endpoints (used to look up the assigned processor set during leader election). | `['wss://public-rpc.canary.acurast.com']` |
| `DOMAIN_SUFFIX` | **Replace with your own domain suffix.** The DNS suffix you control where the wildcard `*` and `_acu` TXT records have been published (see Quick Start step 2). | `'tunnel.example.com'` |
| `LOCAL_ADDRESS` | Local `host:port` the HTTP server binds to and the tunnel forwards traffic into. Any unprivileged port works. | `'127.0.0.1:8080'` |
| `P2P_RELAYS` | Acurast P2P relayer multiaddrs, used by the coordinator for leader election.

### `.env` — deployment secrets

```bash
cp .env.example .env
```

| Variable | Purpose |
| --- | --- |
| `ACURAST_MNEMONIC` | Your deployer's seed phrase. Used by the CLI to sign the on-chain deployment extrinsic. **Do not commit this file.** |

No app-level environment variables are required for this example (`includeEnvironmentVariables` in `acurast.json` is empty).

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

This runs `npm run bundle` then `acurast deploy`, which uploads `./dist` to IPFS and registers the deployment on-chain.


```bash
curl -k https://<clientId>.<DOMAIN_SUFFIX>:8443/
```
