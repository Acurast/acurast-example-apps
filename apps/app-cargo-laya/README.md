# Acurast Example App: Laya decision model (Cargo)

Runs [Laya](https://huggingface.co/convaiinnovations/laya), an open "System 1" decision model, on a phone in the Acurast Cloud, with an HTTP API and 10 browser demos (Snake, Tetris, mail sorter, dating app, newsroom, jailbreak guard, chat moderator, anonymous hotline, API docs, live stats).

Laya doesn't generate text: you send it a `state` and typed questions (`choice`, `score`, `noul`), and it answers with calibrated probabilities. The API is compatible with TypeSafe Jev's `/v1/systemone`.

## How it works

`start.sh` runs in two phases inside an Ubuntu `proot-distro` rootfs:

1. **SSH + tunnel:** installs a few packages, starts [Dropbear](https://github.com/mkj/dropbear) SSH on `127.0.0.1:2222` and the Acurast reverse tunnel (`tunnel.py`). The **primary** connection (Let's Encrypt cert) forwards to the Laya server, the **secondary** one to SSH for debugging.
2. **Laya:** installs CPU-only PyTorch and `laya[serve]`, downloads the English checkpoint (~800 MB) and starts `serve.py` on `127.0.0.1:8080`.

Every step is skipped when already done, so a restart within the same deployment is ready in seconds. If phase 2 fails, SSH and the tunnel stay up so you can debug.

`serve.py` wraps Laya's server and adds:

| Route | What |
|---|---|
| `POST /v1/systemone` | Decisions (bearer token `LAYA_API_KEY`) |
| `GET /` and `/*.html` | The demo pages, with link previews for X and other sites |
| `GET /instance` | Which phone serves this: country, chip, RAM, processor address |
| `GET /feed?url=` | Fetches an RSS/Atom feed on the phone (public hosts only, feeds only) |
| `GET /llms.txt` | The API in one file, for AI agents |
| `GET /stats`, `/hit` | Aggregate counters: no IPs, no IDs, no cookies |

Request logging is off.

## Setup

```bash
cp .env.example .env   # set ACURAST_MNEMONIC, LAYA_API_KEY, CALLBACK_URL, SSH_PASSWORD
npm i -g @acurast/cli
acurast deploy
```

The tunnel URL arrives at `CALLBACK_URL` as `{"event": "started", "url": ...}`, and `{"event": "ready"}` once the model is loaded (about 10-15 min on the first run).

## Notes

- **Several phones:** raise `numberOfReplicas`, and give them time to publish their keys (`startAt.msFromNow` of 10 min or more). Then check that every phone got the environment variables; if not, run `acurast deployments <id> -e`. Without them a phone stops at startup, since `LAYA_API_KEY` is required.
- Speed: about 2-4 s per question on a phone CPU. Fewer questions per request is faster.
- `LAYA_DEMO_PUBLIC=1` hands the API key to the demo pages, so anyone with the URL can use them (and the API). Leave it empty to make visitors enter the key.
- The API key never goes into the deployment bundle (which is uploaded to IPFS); the phone builds `/config.js` from the environment at runtime.
