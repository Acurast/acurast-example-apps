# Acurast Example App: OpenClaw (Cargo, Control UI + SSH)

> 📖 **Docs / full walkthrough:** [Run the OpenClaw AI Assistant on Acurast](https://docs.acurast.com/developers/examples/openclaw)

Runs [OpenClaw](https://openclaw.ai) — an open-source personal AI assistant
("the AI that actually does things") — on an Acurast processor, exposed over the
**Acurast Tunnel** two ways at once:

- **Primary connection → OpenClaw Control UI** (HTTP on `18789`). Open the tunnel
  URL in a browser for the full chat / config / sessions dashboard.
- **Secondary connection → SSH** (dropbear on `2222`). SSH in for the `openclaw`
  CLI (e.g. `openclaw onboard` to link chat channels) or to debug.

The two-connection tunnel is the same shape as
[`app-cargo-hermes`](../app-cargo-hermes) (primary = service, secondary = SSH);
the SSH-behind-tunnel half also matches [`app-cargo-claude`](../app-cargo-claude).

## How it works

1. `start.sh` (the Cargo entrypoint) installs `dropbear`, builds the
   `getifaddrs` shim (see [PRoot Quirks](https://docs.acurast.com/developers/build/cargo-runtime-environment#proot-quirks)),
   sets the root password, and starts `dropbear` on `127.0.0.1:2222`.
2. `tunnel.py` opens the Acurast reverse tunnel with **two** connections —
   primary → Control UI (`127.0.0.1:18789`), secondary → SSH (`127.0.0.1:2222`)
   — and reports both URLs to `CALLBACK_URL`.
3. Phase 2 installs a prebuilt Node.js and the `openclaw` npm package, writes a
   headless OpenClaw config (gateway bound to loopback `18789`, **password auth
   forced** on the Control UI, model pinned to **OpenRouter** —
   `agents.defaults.model = openrouter/$OPENCLAW_MODEL`), and starts the
   **OpenClaw gateway** — which serves the Control UI. SSH + the tunnel come up
   *first*, so a slow or failed phase 2 is still debuggable over the secondary
   SSH connection.

## Connect

Tail your `CALLBACK_URL` for the `started` event — it carries both the Control UI
`url` and the SSH `connect` command.

**Control UI (primary):** open the `url` in a browser:

```
https://<clientId>.<DOMAIN_SUFFIX>
```

Authenticate with `OPENCLAW_GATEWAY_PASSWORD` — either the value you set, or the
auto-generated one delivered via the `webui_password` callback event.

**SSH (secondary, self-signed cert, port `443`):** for the `openclaw` CLI or
debugging:

```bash
ssh -o ProxyCommand='openssl s_client -quiet \
  -servername <secondaryClientId>.<DOMAIN_SUFFIX> \
  -connect <secondaryClientId>.<DOMAIN_SUFFIX>:443' \
  root@<secondaryClientId>
```

Authenticate with `SSH_PASSWORD`, then run `openclaw` (or `openclaw onboard` for
first-time setup). OpenClaw connects through chat apps (WhatsApp, Telegram,
Discord, Slack, Signal); link a channel from the Control UI or via onboarding.

## Configure

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `ACURAST_MNEMONIC` | yes | Deployer seed phrase. **Do not commit.** |
| `OPENROUTER_API_KEY` | yes | [OpenRouter](https://openrouter.ai/keys) API key; exported into the session and read by OpenClaw (pinned to `provider=openrouter`). |
| `OPENCLAW_MODEL` | no (default `openai/gpt-4o-mini`) | OpenRouter model id, e.g. `openai/gpt-4o`, `anthropic/claude-sonnet-4`. The `openrouter/` prefix is added automatically. |
| `OPENCLAW_GATEWAY_PASSWORD` | no | Password protecting the public Control UI URL. **If unset, `start.sh` generates a strong one and reports it as the `webui_password` callback event** — the URL is never left open. Set it explicitly to choose your own. |
| `SSH_PASSWORD` | no (default `password`) | Root password for the SSH session. **Set a strong value.** |
| `CALLBACK_URL` | no | Webhook for `log`/`started`/`error` events. |
| `NETWORK` | yes | Target network: `canary` or `mainnet`. Selects the tunnel relays at runtime. Must match the `network` field in `acurast.json`. |
| `DOMAIN_SUFFIX_CANARY` / `DOMAIN_SUFFIX_MAINNET` | no | **Optional** custom domain suffix, one per network. When unset, falls back to the network default (`acu.run` / `canary.acu.run`). If set, the matching var must also be listed in `acurast.json`'s `includeEnvironmentVariables`. |

## Deploy

```bash
npm i
npm run deploy
```

## Notes

- Installs a prebuilt Node.js and the `openclaw` npm package at runtime, so the
  first start downloads a fair amount — allow time within `maxExecutionTimeInMs`
  (2 hours by default).
- The Control UI binds loopback and the tunnel forwards FROM loopback, so OpenClaw
  would otherwise treat every request as trusted-local and skip auth. `start.sh`
  forces `gateway.auth.mode=password` so the public URL is always protected.
- If `tunnel.py` logs "No secondary tunnel returned", the processor build
  predates `secondaryLocalAddr` support and the SSH path won't be reachable
  (the Control UI still works).
- The session is ephemeral — config and memory are **lost when the deployment
  ends**.
- Full tunnel docs: [Tunnel Quick Start](https://docs.acurast.com/developers/getting-started/quickstart-tunnel).
