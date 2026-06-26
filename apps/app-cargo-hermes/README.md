# Acurast Example App: Hermes (Cargo, via SSH)

Runs [Hermes](https://hermes-agent.org) — an open-source autonomous AI agent by
Nous Research — on an Acurast processor, reachable over **SSH through the
Acurast Tunnel**. You SSH into the deployment and run `hermes` interactively.

Same SSH-behind-tunnel shape as [`app-cargo-claude`](../app-cargo-claude) and
[`app-cargo-openclaw`](../app-cargo-openclaw).

## How it works

1. `start.sh` (the Cargo entrypoint) installs `dropbear` + `git`, builds the
   `getifaddrs` shim (see [PRoot Quirks](https://docs.acurast.com/developers/build/cargo-runtime-environment#proot-quirks)),
   then runs the official Hermes installer, which manages its own `uv` +
   Python 3.11 under `$HOME/.local` (no sudo).
2. It exports your deployment env (incl. `OPENAI_API_KEY`) into `/etc/profile.d`
   so it's set in the SSH session, sets the root password, and starts `dropbear`
   on `127.0.0.1:2222`.
3. `tunnel.py` opens the Acurast reverse tunnel forwarding to dropbear and
   reports the public URL + connect command to `CALLBACK_URL`.

## Connect

Tail your `CALLBACK_URL` for the `started` event to get the exact command, then:

```bash
ssh -o ProxyCommand='openssl s_client -quiet \
  -servername <clientId>.<DOMAIN_SUFFIX> \
  -connect <clientId>.<DOMAIN_SUFFIX>:8443' \
  root@<clientId>
```

Authenticate with `SSH_PASSWORD`, then:

```bash
hermes
```

Hermes can also bridge to chat platforms (Telegram, Discord, Slack, WhatsApp,
Signal) via its optional gateway — see the Hermes docs.

## Configure

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `ACURAST_MNEMONIC` | yes | Deployer seed phrase. **Do not commit.** |
| `OPENAI_API_KEY` | yes | LLM key (OpenAI-compatible endpoint); exported into the SSH session. |
| `SSH_PASSWORD` | no (default `password`) | Root password for the SSH session. **Set a strong value.** |
| `CALLBACK_URL` | no | Webhook for `log`/`started`/`error` events. |
| `NETWORK` | yes | Target network: `canary` or `mainnet`. Selects the tunnel relays at runtime. Must match the `network` field in `acurast.json`. |
| `DOMAIN_SUFFIX_CANARY` / `DOMAIN_SUFFIX_MAINNET` | active one | Your tunnel DNS suffix (wildcard `*` + `_acu` TXT records published), one per network. Set only the one matching `NETWORK`. |

## Deploy

```bash
npm i
npm run deploy
```

## Notes

- Installs `uv` + Python 3.11 at runtime via the official installer, so the
  first start downloads a fair amount — allow time within `maxExecutionTimeInMs`
  (2 hours by default).
- The session is ephemeral — memory/skills are **lost when the deployment
  ends**.
- Full tunnel docs: [Tunnel Quick Start](https://docs.acurast.com/developers/getting-started/quickstart-tunnel).
