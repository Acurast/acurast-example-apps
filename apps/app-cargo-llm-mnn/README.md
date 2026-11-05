# Acurast Example App: LLM on MNN (Cargo)

Runs Qwen3.5 on a phone in the Acurast Cloud with Alibaba's MNN engine and serves it as an OpenAI-compatible HTTPS API over the Acurast Tunnel.

It is the Cargo (Shell runtime) sibling of [app-llm-qwen](../app-llm-qwen), which uses the llama.cpp built into the processor. This one brings its own inference engine: [MNN](https://github.com/alibaba/MNN), installed with `pip install MNN` inside an Ubuntu rootfs, with Alibaba's MNN builds of Qwen3.5 from Hugging Face. The default model is Qwen3.5-4B.

## Why MNN

Measured on Acurast phones on 5 November 2026, MNN against llama.cpp (CPU) with the same Qwen3.5 models:

- Qwen3.5-0.8B generates 31-36 % faster.
- Long prompts: Qwen3.5-9B reads a 7,000-token prompt at 35.9 tok/s, llama.cpp at 13.7 tok/s. llama.cpp slows down sharply as the context grows.

MNN reading 7,000-token prompts on a Snapdragon 8 Elite-class phone with 16 GB RAM:

| Model | Prompt reading (7,000 tokens) |
| --- | --- |
| Qwen3.5-0.8B | 479.6 tok/s |
| Qwen3.5-4B | 72.3 tok/s |
| Qwen3.5-9B | 35.9 tok/s |

## How it works

The job runs on the [proot-distro](https://github.com/termux/proot-distro) Ubuntu 25.10 rootfs (the MNN wheels need glibc). `app/start.sh` runs in two phases:

1. **Tunnel:** installs `python3-venv`, `openssl` and `curl`, then opens the Acurast reverse tunnel (`tunnel.py`). The **primary** connection (Let's Encrypt cert) forwards to the API on `127.0.0.1:8080`. If `SSH_PASSWORD` is set, it also starts [Dropbear](https://github.com/mkj/dropbear) SSH on `127.0.0.1:2222`, reachable over the **secondary** connection for debugging.
2. **Model:** installs `MNN==3.6.2` into a venv and starts `server.py`. The server answers `/info` right away, downloads the model from Hugging Face (pinned revision, resumed after interruptions, each file checked against the sha256 or git hash Hugging Face lists for it), loads it and serves the API.

The rootfs survives restarts within a deployment, so the venv and the model are set up once. If phase 2 fails, the tunnel stays up and `/info` shows the error.

`server.py` is plain Python (`http.server`, no web framework):

| Route | What |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible chat API (`Authorization: Bearer <LLM_API_KEY>`), with `"stream": true` support |
| `GET /v1/models` | The served model (same key) |
| `GET /info` | Phase (`download`, `load`, `ready`, `error`), download progress, model, threads, the phone's chip, cores and RAM, speed of the last request. No key needed. |
| `GET /health` | `{"status": "ok"}` once the model is loaded, `503` before |

Until the model is loaded, the chat API answers `503`. Without `LLM_API_KEY` the app does not start: the URL is public, so it never serves the model without a key.

## Setup

### Requirements

- The [Acurast CLI](https://github.com/Acurast/acurast-cli): `npm i -g @acurast/cli`
- An Acurast mnemonic with a few ACU on mainnet (`acurast init` creates one).

### Configure

```bash
cp .env.example .env    # set ACURAST_MNEMONIC and LLM_API_KEY (openssl rand -hex 16)
tools/tunnel_key.sh     # prints TUNNEL_KEY=... for .env and the URL the phone will get
```

| Variable | Required | Description |
| --- | --- | --- |
| `ACURAST_MNEMONIC` | yes | Deployer seed phrase. **Do not commit.** |
| `NETWORK` | yes | `mainnet` or `canary`. Selects the tunnel relays. Must match `network` in `acurast.json`. |
| `LLM_API_KEY` | yes | Bearer token clients must send. |
| `TUNNEL_KEY` | no | Fixes the URL (`tools/tunnel_key.sh`). Empty: a new random URL on every start, sent to `CALLBACK_URL`. One phone per key. |
| `LLM_MODEL` | no | `0.8B`, `4B` (default) or `9B`. Change `minRamTotalBytes` with it (table below). |
| `LLM_THREADS` | no | MNN threads. Default: 8 on phones without efficiency cores, else 4 (see Notes). Setting it also turns off the core pinning. |
| `LLM_THINKING` | no | `1`: the model thinks before answering, unless a request turns it off. Default: direct answers. |
| `CALLBACK_URL` | no | Webhook for lifecycle events (`log`, `started` with the URL, `ready`, `error`). |
| `SSH_PASSWORD` | no | Starts SSH over the secondary tunnel connection. Empty: no SSH. |

### Deploy

```bash
acurast deploy --dry-run   # how many phones match the filters, and the current price
acurast deploy
```

After matching, the phone installs MNN and downloads the model (2.6 GB for the default 4B). Follow it at `https://<id>.mainnet.acu.run/info`. Then call the API:

```bash
curl https://<id>.mainnet.acu.run/v1/chat/completions \
  -H "Authorization: Bearer $LLM_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.5","messages":[{"role":"user","content":"Hello from a phone?"}],"max_tokens":200}'

# Streaming: tokens arrive as server-sent events while they are generated
curl -N https://<id>.mainnet.acu.run/v1/chat/completions \
  -H "Authorization: Bearer $LLM_API_KEY" -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Name three planets."}],"stream":true}'
```

Any OpenAI client works with `https://<id>.mainnet.acu.run/v1` as the base URL and `LLM_API_KEY` as the API key. The `model` field is ignored: the phone serves the one model it loaded.

## Choosing the model and the phones

`benchmarkFilters` in `acurast.json` selects phones by their on-chain benchmarks. The phone needs RAM for the model plus the context.

| `LLM_MODEL` | Hugging Face | Download | `minRamTotalBytes` | `minCpuSingleCoreScore` |
| --- | --- | --- | --- | --- |
| `0.8B` | [taobao-mnn/Qwen3.5-0.8B-MNN](https://huggingface.co/taobao-mnn/Qwen3.5-0.8B-MNN) | 0.5 GB | 3500000000 | 140000000 |
| `4B` (default) | [taobao-mnn/Qwen3.5-4B-MNN](https://huggingface.co/taobao-mnn/Qwen3.5-4B-MNN) | 2.6 GB | 7500000000 | 140000000 |
| `9B` | [taobao-mnn/Qwen3.5-9B-MNN](https://huggingface.co/taobao-mnn/Qwen3.5-9B-MNN) | 7.0 GB | 15000000000 | 140000000 |

The 9B is meant for 16 GB phones; its download includes a 2 GB embedding file next to the weights. The image files of these repositories (`visual.mnn*`) are not downloaded: the API is text only.

## Notes

- **Thinking:** Qwen3.5 starts every answer with a long reasoning section unless told otherwise. This app turns it off by default through MNN's chat-template context (`set_config({"jinja": {"context": {"enable_thinking": false}}})`), so the template closes the thinking block before the answer. A request can turn it on with `"chat_template_kwargs": {"enable_thinking": true}` (the same field llama.cpp and vLLM read); the reasoning then comes inline in `content`, ending with `</think>`.
- **Streaming:** MNN's Python API writes streamed tokens only to the process's standard output. `server.py` points that output at a pipe it reads, and forwards each token as a server-sent event. MNN also prints every prompt and answer there; they stay in the pipe and never reach the phone's log. If a streaming client disconnects, generation stops at the next token.
- **One request at a time:** there is one model in memory; parallel requests wait their turn. Each request reads the whole conversation again (no cache between requests).
- **Sampling** is fixed when the model loads (MNN builds its sampler once): temperature 0.7 and top-p 0.8 for direct answers, the model's own 1.0 / 0.95 with `LLM_THINKING=1`. `temperature`, `top_p` and `stop` in requests are ignored. `max_tokens` (default 2048, at most 8192) is honoured.
- **Threads:** MNN measured fastest with 8 threads on Snapdragon 8 Elite-class phones and 4 on most others. `server.py` reads each core's speed (`cpu_capacity`, else the max frequency): if every core is fast (no efficiency cluster) it uses all of them, up to 8; otherwise 4, pinned to the fast cores. It is a heuristic; set `LLM_THREADS` to override.
- MNN logs `Can't open file: .../visual.mnn` when it loads. That is the image module, which is not downloaded; text works.
- No request logging. `/info` shows token counts and speed of the last request, never its content.
- `python3 tools/test_server.py` checks the thread choice, the stream framing and the request parsing without a phone.

## License

The code is MIT. MNN is Apache-2.0. The Qwen3.5 weights are Apache-2.0 (MNN conversions by Alibaba's MNN team, `taobao-mnn` on Hugging Face).
