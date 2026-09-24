# Acurast Example App: Laya decision model (Cargo)

Runs [Laya](https://huggingface.co/convaiinnovations/laya), an open "System 1" decision model, on a phone in the Acurast Cloud, with an HTTP API and 10 browser demos (Snake, Tetris, mail sorter, dating app, newsroom, jailbreak guard, chat moderator, anonymous hotline, API docs, live stats).

Laya doesn't generate text: you send it a `state` and typed questions (`choice`, `score`, `noul`), and it answers with calibrated probabilities. The API is compatible with TypeSafe Jev's `/v1/systemone`.

## How it works

The job runs on the [Acurast ONNX base image](../../images/onnx) (Alpine, Python, ONNX Runtime, tokenizers, openssl, Dropbear, curl; 47 MB download), so it installs nothing. `start.sh` runs in two phases:

1. **SSH + tunnel:** starts [Dropbear](https://github.com/mkj/dropbear) SSH on `127.0.0.1:2222` and the Acurast reverse tunnel (`tunnel.py`). The **primary** connection (Let's Encrypt cert) forwards to the Laya server, the **secondary** one to SSH for debugging.
2. **Laya:** starts `serve.py` on `127.0.0.1:8080`, which downloads the model (~630 MB from the CDN, each file checked against a sha256 pinned in `serve.py`) while the demo pages show the progress, then loads it.

The demos are reachable a few seconds after the phone unpacks the 47 MB image; the model downloads once per deployment, so a restart is ready in seconds. If phase 2 fails, SSH and the tunnel stay up so you can debug.

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
cp .env.example .env   # set ACURAST_MNEMONIC, LAYA_API_KEY, SSH_PASSWORD
npm i -g @acurast/cli
tools/tunnel_key.sh    # prints TUNNEL_KEY for .env and the URL the deployment will have
acurast deploy
```

The URL is fixed by `TUNNEL_KEY`, so it is known before deploying. It serves the demos once the phone has downloaded the model (a few minutes on the first run; the pages show the progress).

**Several phones:** `tools/deploy.sh` deploys one phone per instance, each with its own key and URL, and prints them as a JSON array:

```bash
tools/deploy.sh 10 10 --wait   # 10 phones, 10 days
```

Options: `--min-cpu` / `--min-cpu-multi` (minimum on-chain CPU benchmark scores, overriding the default in `acurast.json`: single-core 100000000 and 4 GB RAM, which about 1,650 phones meet; the fastest score about 2.8e8), `--acu-per-day` (max price, default 0.8), `--wait` (also time until each URL serves the model). The keys go to `.acurast/tunnel-keys.env`; redeploying with a key keeps its URL.

## Notes

- Speed: about 0.25-0.4 s per question on a Pixel 7a (Tensor G2), where the previous PyTorch version took 3.5 s. Fewer questions per request is faster.
- `LAYA_DEMO_PUBLIC=1` hands the API key to the demo pages, so anyone with the URL can use them (and the API). Leave it empty to make visitors enter the key.
- The API key never goes into the deployment bundle (which is uploaded to IPFS); the phone builds `/config.js` from the environment at runtime.

## Where the files live

Everything the phone or the browser downloads is on `cdn.papers.tech` under `files/cargo-laya/<sha256>/`, uploaded through the Acurast orchestrator (`scripts/cdn_upload.py cargo-laya <dir> <prefix>` in acurast-orchestrator):

| Prefix | What | Used by |
|---|---|---|
| `onnx-base/` | the base rootfs, its package licences (`THIRD-PARTY.tsv`), source for the copyleft packages (`sources/`, `SOURCE.md`) | `acurast.json` (`image`) |
| `laya-english-onnx-int8/` | the model, with `LICENSE` and `NOTICE` (Apache-2.0: what was changed) | `serve.py` (`MODEL_FILES`) |
| `doom/` | Chocolate Doom (WebAssembly) with Freedoom 2, its licences and GPL source (`SOURCE.md`) | `demos/doom.html` (`ENGINE`), loaded by the browser |

URLs contain the sha256, so a new version is a new URL: update the pinned hashes when you rebuild.

## Licences

- Laya (Convai Innovations) and ModernBERT (Answer.AI, LightOn): Apache-2.0. We ship a modified version (ONNX, 8-bit), with the licence and a notice of the changes next to the weights; the demo footer links it. `app/laya_onnx.py` is derived from the `laya` package (Apache-2.0) and says so in its header.
- Base image: Alpine packages under their own licences (`THIRD-PARTY.tsv`); for GPL/LGPL/MPL packages the corresponding source is published next to the image (`images/onnx/sources.sh`).
- Doom: Chocolate Doom and the state bridge are GPL-2.0-or-later, with the complete corresponding source next to the engine (`tools/package_doom.sh`); Freedoom is BSD. The page links both.

## Rebuilding the model

`tools/export_model.py` exports the checkpoint to ONNX, quantizes it and checks the answers against Laya on PyTorch (max probability difference 0.05). Only this step needs PyTorch. Upload the directory it writes (`cdn_upload.py cargo-laya tools/out/model laya-english-onnx-int8`) and update `MODEL_FILES` in `serve.py`. `python3 tools/test_perf_cores.py` checks the core selection.

We measured on a Pixel 7a: 4-bit weights and int8 dynamic quantization drift too far (probabilities off by 0.1-0.2); NNAPI (the Tensor TPU) and WebGPU (the Mali GPU) were slower than the CPU or failed.
