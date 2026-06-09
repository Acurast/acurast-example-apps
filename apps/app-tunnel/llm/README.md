# Acurast Example App: Tunnel (LLM)

This example runs a quantized LLM (Qwen2.5-3B-Instruct) on an Acurast processor
using the **Shell runtime**, exposes it through an **Acurast reverse tunnel**, and
consumes it end-to-end through **NodeGhost** — a POKT-routed, OpenAI-compatible
inference gateway — as a bring-your-own-model (BYOM) endpoint.

It is the LLM variant of the tunnel example family: where `app-tunnel/cargo`
serves SSH over the tunnel, this serves a llama-server inference endpoint.

## What it does

1. Sets up a proot Ubuntu environment and builds a small loopback shim
   (`getifaddrs_override.c`) so the local server binds correctly inside the
   container.
2. Downloads `llama.cpp` and the `Qwen2.5-3B-Instruct-Q4_K_M` model at runtime.
3. Starts `llama-server` on `127.0.0.1:8080` behind a health-gated readiness
   loop, capturing stderr for diagnostics.
4. Opens an Acurast reverse tunnel to the local server, generating an ephemeral
   identity and reporting lifecycle events to a callback URL.
5. The resulting public tunnel URL is registered with NodeGhost as a BYOM
   endpoint, after which NodeGhost routes OpenAI-compatible chat requests through
   the tunnel to the on-device model.

## About NodeGhost

NodeGhost routes inference requests over the POKT (Pocket Network) decentralized
layer and exposes an OpenAI-compatible API. It supports bring-your-own-model
(BYOM): an operator points an API key at their own model backend instead of a
hosted model. In this example, that backend is the Acurast-hosted `llama-server`,
reached over the tunnel — so a standard OpenAI-style request lands on a model
running on an Acurast processor.

## How it fits together

```
Acurast processor (Shell runtime / proot)
  └─ llama-server :8080            (Qwen2.5-3B-Instruct-Q4_K_M)
       └─ Acurast reverse tunnel   →  https://<clientId>.<your-tunnel-domain>:8443
            └─ registered as a NodeGhost BYOM endpoint
                 └─ POST https://<gateway>/v1/chat/completions
                      →  routed over the tunnel  →  inference on the processor
```

## Configure

### `app/tunnel.py` — code-side constants

| Constant | Purpose | Example |
| --- | --- | --- |
| `TUNNEL_RELAYS` | Tunnel relay endpoints to connect to. | `["relay-2.canary.acurast.com:4433", …]` |
| `DOMAIN_SUFFIX` | **Replace with your own domain suffix.** The DNS suffix you control where the wildcard `*` and `_acu` TXT records have been published (see the Tunnel Quick Start). | `"tunnel.example.com"` |
| `LLAMA_PORT` | Local port `llama-server` listens on and the tunnel forwards to. Must be >= 1024 (privileged ports can't be bound inside the proot sandbox). | `8080` |
| `LOCAL_ADDR` | Derived from `LLAMA_PORT`, i.e. `127.0.0.1:<LLAMA_PORT>`. | `"127.0.0.1:8080"` |
| `STATUS_POLL_INTERVAL_SEC` | How often the script polls `tunnel_status` after start (just for log visibility). | `30` |

Additional runtime values (`BRIDGE_SOCKET`, `CALLBACK_URL`) are read from the
environment.

### Environment variables (`.env`)

Copy `.env.example` to `.env` and fill in your own values. **Never commit `.env`.**

| Variable           | Description                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `ACURAST_MNEMONIC` | Your Acurast deployer wallet mnemonic.                                                               |
| `CALLBACK_URL`     | An HTTP endpoint that receives lifecycle events (including the tunnel URL). Use your own receiver.    |

> The callback exists because the tunnel subdomain is derived from an ephemeral
> key generated at runtime — it is not knowable in advance. The callback is how
> the deployment reports its actual tunnel URL (and its progress) back to you.
> [webhook.site](https://webhook.site) is the quick way to get a receiver URL for
> testing. Treat your callback URL as sensitive: anyone who has it can see your
> lifecycle events, which include the tunnel URL.

### `acurast.json`

| Field                  | Value                              |
| ---------------------- | ---------------------------------- |
| `runtime`              | `"Shell"`                          |
| `fileUrl`              | `"app"`                            |
| `entrypoint`           | `"start.sh"`                       |
| `requiredModules`      | `["Shell"]`                        |
| `network`              | `"canary"`                         |
| `onlyAttestedDevices`  | `true`                             |
| execution             | one-time, 2h max                   |
| `minProcessorVersions` | `{ "android": 122 }`               |

`acurast deploy` uploads the `app/` directory to IPFS and submits the
deployment — there is no TypeScript bundling step for Shell-runtime apps.

## Deploy & verify

### Deploy

```bash
cp .env.example .env      # then fill in ACURAST_MNEMONIC and CALLBACK_URL
acurast deploy
```

### Verify

Watch your callback receiver for the lifecycle sequence:

1. environment setup
2. `llama.cpp` download
3. model download (~2GB)
4. waiting for `llama-server` to load the model
5. `llama-server` ready → starting the reverse tunnel
6. **`started`** — carries the public tunnel `url`

The `started` event looks like:

```json
{
  "event": "started",
  "url": "https://<clientId>.<your-tunnel-domain>:8443",
  "port": 8080
}
```

Copy the `url` from the `started` event (it is the public tunnel URL on port
`8443`), then register it with NodeGhost as a BYOM endpoint and send a request:

```bash
# Register the tunnel URL as a BYOM endpoint (omit endpoint_key —
# llama-server is unauthenticated by default).
curl -X POST https://<gateway>/v1/endpoint/register \
  -H "Authorization: Bearer <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"endpoint_url": "https://<clientId>.<your-tunnel-domain>:8443", "endpoint_name": "acurast-tunnel-llm"}'

# Send an OpenAI-compatible chat request through the gateway.
curl https://<gateway>/v1/chat/completions \
  -H "Authorization: Bearer <your-key>" \
  -H "Content-Type: application/json" \
  -d '{
        "model": "Qwen2.5-3B-Instruct-Q4_K_M.gguf",
        "messages": [{"role": "user", "content": "Hello"}]
      }'
```

The response includes the model name, confirming the request was served by the
Acurast-hosted model over the tunnel.

## Notes

- **Ephemeral tunnel subdomain.** The tunnel identity (a P-256 key) is generated
  fresh on each run, so every redeploy produces a new subdomain. The URL is
  per-deployment: it lives only as long as the deployment runs and stops working
  once the deployment ends. Re-register the new URL after each redeploy. For a
  stable URL you can either persist the key in the bundle (a leaked bundle then
  carries the address) or have the consuming gateway update the registered
  endpoint when the URL changes.

- **Loopback shim.** `getifaddrs_override.c` is `LD_PRELOAD`-ed so `llama-server`
  binds correctly inside the proot environment.

- **Processor version.** `minProcessorVersions` is pinned to `{ android: 122 }` to
  match the tunnel example family. In our own testing the deployment also matched
  on an open pool without that gate appearing to be the limiting factor, so if you
  run into matching issues it is the first thing to revisit.

- **Performance.** A 3B Q4 model on a mobile ARM CPU generates roughly 3 tokens
  per second; a ~120-token reply takes around 45 seconds, and the model makes
  elementary multi-step reasoning mistakes. This is the honest ceiling of this
  model on this hardware, not an infrastructure limitation. The trade-off suits
  asynchronous, batch, or short-context work rather than interactive chat or
  anything latency-sensitive.
