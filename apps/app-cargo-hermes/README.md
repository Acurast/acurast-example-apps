# Acurast Example App: Hermes (Cargo, WebUI + SSH)

Runs [Hermes](https://hermes-agent.org) — an open-source autonomous AI agent by
Nous Research — on an Acurast processor, exposed over the **Acurast Tunnel** two
ways at once:

- **Primary connection → [Hermes WebUI](https://github.com/nesquena/hermes-webui)**
  (HTTP on `8787`). Open the tunnel URL in a browser for the full
  chat / sessions / workspace UI.
- **Secondary connection → SSH** (dropbear on `2222`). SSH in for the `hermes`
  CLI or to debug.

The two-connection tunnel is the same shape as
[`app-cargo-minecraft`](../app-cargo-minecraft) (primary = service, secondary =
SSH); the SSH-behind-tunnel half matches
[`app-cargo-openclaw`](../app-cargo-openclaw).

## How it works

1. `start.sh` (the Cargo entrypoint) installs `dropbear` + `git`, builds the
   `getifaddrs` shim (see [PRoot Quirks](https://docs.acurast.com/developers/build/cargo-runtime-environment#proot-quirks)),
   sets the root password, and starts `dropbear` on `127.0.0.1:2222`.
2. `tunnel.py` opens the Acurast reverse tunnel with **two** connections —
   primary → WebUI (`127.0.0.1:8787`), secondary → SSH (`127.0.0.1:2222`) — and
   reports both URLs to `CALLBACK_URL`.
3. Phase 2 runs the official Hermes installer (its own `uv` + Python 3.11 under
   `$HOME/.local`, no sudo), pins Hermes to **OpenRouter** (`hermes config set
   model.provider openrouter` + `model.model $HERMES_MODEL`), starts the Hermes
   WebUI bound to loopback `8787`, and starts the **Hermes gateway** (cron
   scheduler — without it, scheduled jobs created in the UI never tick). SSH +
   the tunnel come up *first*, so a slow or failed phase 2 is still debuggable
   over the secondary SSH connection.

## Connect

Tail your `CALLBACK_URL` for the `started` event — it carries both the WebUI
`url` and the SSH `connect` command.

**WebUI (primary):** open the `url` in a browser:

```
https://<clientId>.<DOMAIN_SUFFIX>
```

Authenticate with `HERMES_WEBUI_PASSWORD` — either the value you set, or the
auto-generated one delivered via the `webui_password` callback event.

**SSH (secondary, self-signed cert, port `443`):** for the `hermes` CLI or
debugging:

```bash
ssh -o ProxyCommand='openssl s_client -quiet \
  -servername <secondaryClientId>.<DOMAIN_SUFFIX> \
  -connect <secondaryClientId>.<DOMAIN_SUFFIX>:443' \
  root@<secondaryClientId>
```

Authenticate with `SSH_PASSWORD`, then run `hermes`.

The gateway daemon also bridges chat platforms (Telegram, Discord, Slack,
WhatsApp, Signal) — set the relevant platform tokens (`TELEGRAM_*`, etc.) in
`.env` + `includeEnvironmentVariables` and it connects on startup. With no
tokens it still runs, serving the cron scheduler only. See the Hermes docs.

## Configure

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `ACURAST_MNEMONIC` | yes | Deployer seed phrase. **Do not commit.** |
| `OPENROUTER_API_KEY` | yes | [OpenRouter](https://openrouter.ai/keys) API key; exported into the session and read by Hermes (pinned to `provider=openrouter`). |
| `HERMES_MODEL` | no (default `openai/gpt-4o-mini`) | OpenRouter model id, e.g. `openai/gpt-4o`, `anthropic/claude-sonnet-4`. |
| `HERMES_WEBUI_PASSWORD` | no | Password protecting the public WebUI URL. **If unset, `start.sh` generates a strong one and reports it as the `webui_password` callback event** — the URL is never left open. Set it explicitly to choose your own. |
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

- Installs `uv` + Python 3.11 (Hermes) and clones + bootstraps the WebUI at
  runtime, so the first start downloads a fair amount — allow time within
  `maxExecutionTimeInMs` (2 hours by default).
- The WebUI is a community project ([nesquena/hermes-webui](https://github.com/nesquena/hermes-webui),
  MIT) that runs the agent in-process against your existing Hermes config — no
  extra setup.
- If `tunnel.py` logs "No secondary tunnel returned", the processor build
  predates `secondaryLocalAddr` support and the SSH path won't be reachable
  (the WebUI still works).
- The session is ephemeral — memory/skills are **lost when the deployment
  ends**.
- Full tunnel docs: [Tunnel Quick Start](https://docs.acurast.com/developers/getting-started/quickstart-tunnel).
