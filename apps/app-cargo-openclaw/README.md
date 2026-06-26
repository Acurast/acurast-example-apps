# Acurast Example App: OpenClaw (Cargo, via SSH)

Runs [OpenClaw](https://openclaw.ai) — an open-source personal AI assistant
("the AI that actually does things") — on an Acurast processor, reachable over
**SSH through the Acurast Tunnel**. You SSH into the deployment and run
`openclaw onboard` to set it up, then use it interactively.

Same SSH-behind-tunnel shape as [`app-cargo-claude`](../app-cargo-claude) and
[`app-cargo-hermes`](../app-cargo-hermes).

## How it works

1. `start.sh` (the Cargo entrypoint) installs `dropbear`, builds the
   `getifaddrs` shim (see [PRoot Quirks](https://docs.acurast.com/developers/build/cargo-runtime-environment#proot-quirks)),
   installs a prebuilt Node.js and the `openclaw` npm package.
2. It exports your deployment env (incl. the LLM API key) into `/etc/profile.d`
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
openclaw onboard   # first-time setup
```

OpenClaw connects through chat apps (WhatsApp, Telegram, Discord, Slack,
Signal); follow its onboarding to link a channel.

## Configure

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `ACURAST_MNEMONIC` | yes | Deployer seed phrase. **Do not commit.** |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | yes (one) | LLM key for the model OpenClaw uses; exported into the SSH session. |
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

- The session is ephemeral — config and memory are **lost when the deployment
  ends**.
- `maxExecutionTimeInMs` is 2 hours; raise it in `acurast.json` for longer runs.
- Full tunnel docs: [Tunnel Quick Start](https://docs.acurast.com/developers/getting-started/quickstart-tunnel).
