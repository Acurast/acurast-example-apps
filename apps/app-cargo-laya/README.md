# Acurast Example App: Laya decision model (Cargo)

Runs [Laya](https://huggingface.co/convaiinnovations/laya), an open "System 1" decision model, on a phone in the Acurast Cloud, with an HTTP API and 10 browser demos (Snake, Tetris, mail sorter, dating app, newsroom, jailbreak guard, chat moderator, anonymous hotline, API docs, live stats).

Laya doesn't generate text: you send it a `state` and typed questions (`choice`, `score`, `noul`), and it answers with calibrated probabilities. The API is compatible with TypeSafe Jev's `/v1/systemone`.

## How it works

The job runs on the [Acurast ONNX base image](../../images/onnx) (Alpine, Python, ONNX Runtime, tokenizers, openssl, Dropbear, curl; 47 MB download), so it installs nothing. `start.sh` runs in two phases:

1. **SSH + tunnel:** starts [Dropbear](https://github.com/mkj/dropbear) SSH on `127.0.0.1:2222` and the Acurast reverse tunnel (`tunnel.py`). The **primary** connection (Let's Encrypt cert) forwards to the Laya server, the **secondary** one to SSH for debugging.
2. **Laya:** downloads the model (~630 MB, checked against pinned sha256 sums) and starts `serve.py` on `127.0.0.1:8080`.

The model downloads once per deployment, so a restart is ready in seconds. If phase 2 fails, SSH and the tunnel stay up so you can debug.

The model is Laya's English checkpoint as one ONNX graph (encoder and decision head) with 8-bit weights. `laya_onnx.py` runs it with ONNX Runtime; it ports Laya's prompt building and answer format, so there is no PyTorch on the phone. It runs one thread per performance core and pins them there, using the kernel's `cpu_capacity` (else the max frequency); the efficiency cores are left out, since the fast cores would wait for them. `LAYA_THREADS` overrides the thread count.

`serve.py` is plain Python (`http.server`, no web framework):

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

The tunnel URL arrives at `CALLBACK_URL` as `{"event": "started", "url": ...}`, and `{"event": "ready"}` once the model is loaded (a few minutes on the first run, the model download).

## Notes

- **Several phones:** raise `numberOfReplicas`, and give them time to publish their keys (`startAt.msFromNow` of 10 min or more). Then check that every phone got the environment variables; if not, run `acurast deployments <id> -e`. Without them a phone stops at startup, since `LAYA_API_KEY` is required.
- Speed: about 0.25-0.4 s per question on a Pixel 7a (Tensor G2), where the previous PyTorch version took 3.5 s. Fewer questions per request is faster.
- `LAYA_DEMO_PUBLIC=1` hands the API key to the demo pages, so anyone with the URL can use them (and the API). Leave it empty to make visitors enter the key.
- The API key never goes into the deployment bundle (which is uploaded to IPFS); the phone builds `/config.js` from the environment at runtime.

## Rebuilding the model

`tools/export_model.py` exports the checkpoint to ONNX, quantizes it and checks the answers against Laya on PyTorch (max probability difference 0.05). Only this step needs PyTorch. Upload the four files it writes and update `LAYA_MODEL_URL` and the sha256 sums in `start.sh`. `python3 tools/test_perf_cores.py` checks the core selection.

We measured on a Pixel 7a: 4-bit weights and int8 dynamic quantization drift too far (probabilities off by 0.1-0.2); NNAPI (the Tensor TPU) and WebGPU (the Mali GPU) were slower than the CPU or failed.
