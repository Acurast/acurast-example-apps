# Acurast Example App: LLM (Qwen3.5)

Runs the open-weight Qwen3.5 LLM on a phone in the Acurast Cloud and serves it as an OpenAI-compatible HTTPS API, with a chat page in the browser.

It uses the Node.js runtime with the llama.cpp server built into the Acurast processor (`requiredModules: ["LLM"]`), so there is no container image and no build step: `src/` is deployed as-is. The default model is Qwen3.5-4B (Q4_0, 2.6 GB).

## How it works

`src/index.js` runs these steps on the phone:

1. Starts a small proxy on `127.0.0.1:8080` and opens the Acurast Tunnel to it, so `https://<id>.mainnet.acu.run/info` answers from the first seconds.
2. Downloads the GGUF model from Hugging Face into the job's storage (resumed and retried on errors).
3. Benchmarks a few llama.cpp server configurations (prompt processing and generation speed) and keeps the fastest.
4. Serves that configuration behind the proxy, protected by `LLM_API_KEY`.

| Route | What |
| --- | --- |
| `GET /` | Chat page (`src/chat.html`). Enter the API key at the bottom. |
| `POST /v1/chat/completions` | OpenAI-compatible chat API (`Authorization: Bearer <LLM_API_KEY>`) |
| `GET /info` | Phase (`tunnel`, `download`, `bench`, `ready`), phone details, benchmark results, serving config. No key needed. |
| `GET /logs` | The app's log. No key needed. |

Until the model is ready, the API answers `503` with the current phase. If `LLM_API_KEY` is empty, the app stops after opening the tunnel and `/info` says why: the URL is public, so it never serves the model without a key.

## Setup

### Requirements

- The [Acurast CLI](https://github.com/Acurast/acurast-cli) 0.11 or newer: `npm i -g @acurast/cli`
- An Acurast mnemonic with a few ACU on mainnet (`acurast init` creates one).

### Configure

```bash
cp .env.example .env
node tools/gen-tunnel-keys.mjs --new-seed 1
```

The second command prints `TUNNEL_SEED=...` (copy it into `.env`) and the URL the phone will get, for example `slot 0: https://<id>.mainnet.acu.run`. The URL is derived from the seed, so it is known before deploying and stays the same when you redeploy with the same seed. To see the URL of an existing seed again:

```bash
node tools/gen-tunnel-keys.mjs --seed <TUNNEL_SEED> 1
```

| Variable | Required | Description |
| --- | --- | --- |
| `ACURAST_MNEMONIC` | yes | Deployer seed phrase. **Do not commit.** |
| `NETWORK` | yes | `mainnet` or `canary`. Selects the tunnel relays. Must match `network` in `acurast.json`. |
| `TUNNEL_SEED` | yes | 32-byte hex seed that fixes the tunnel URL of each phone. |
| `LLM_API_KEY` | yes | Bearer token clients must send. Any random string, e.g. `openssl rand -hex 16`. |
| `MODEL_URL` | no | Another GGUF model (see below). |

Optional overrides (`MODEL_URL`, `CTX_SIZE`, `PARALLEL`, `KV_TYPE`, `VARIANTS`, `BENCH_THREADS`) have their defaults at the top of `src/index.js`. If you set one, also add its name to `includeEnvironmentVariables` in `acurast.json`, or it is not sent to the phone.

### Deploy

```bash
acurast deploy --dry-run   # how many phones match the filters, and the current price
acurast deploy
```

After a few minutes (matching, then the model download), open `https://<id>.mainnet.acu.run/` for the chat page, or call the API:

```bash
curl https://<id>.mainnet.acu.run/v1/chat/completions \
  -H "Authorization: Bearer $LLM_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.5","messages":[{"role":"user","content":"Hello from a phone?"}],"max_tokens":200,"chat_template_kwargs":{"enable_thinking":false}}'

curl https://<id>.mainnet.acu.run/info   # progress while it starts
```

Any OpenAI client works with `https://<id>.mainnet.acu.run/v1` as the base URL and `LLM_API_KEY` as the API key.

## Choosing the model and the phones

`benchmarkFilters` in `acurast.json` selects phones by their on-chain benchmarks. The filter has to match the model: the phone needs RAM for the model plus the context.

| Model | File | `minRamTotalBytes` | `minCpuSingleCoreScore` | Speed (single stream) |
| --- | --- | --- | --- | --- |
| [Qwen3.5-0.8B Q8_0](https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf) | 0.8 GB | 3500000000 | 140000000 | 28-33 tok/s |
| [Qwen3.5-4B Q4_0](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_0.gguf) (default) | 2.6 GB | 7500000000 | 140000000 | 7-10 tok/s |
| [Qwen3.5-9B Q4_K_M](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf) | 5.7 GB | 15000000000 | 140000000 | 3.7-4.4 tok/s, 16 GB phones |

Speeds were measured on mainnet phones in October 2026. To switch model, set `MODEL_URL` in `.env` to the link in the table, add `"MODEL_URL"` to `includeEnvironmentVariables`, and set `minRamTotalBytes` to the value in the same row.

**Several phones:** set `numberOfReplicas` in `acurast.json`. Every phone gets its own URL from the same seed; `node tools/gen-tunnel-keys.mjs --seed <TUNNEL_SEED> <replicas>` lists them.

## Notes

- Needs processor version 1.27.1 or newer (`minProcessorVersions`): the llama.cpp in older versions cannot load Qwen3.5.
- Inside the phone's sandbox `os.cpus()` is empty, so the app counts cores with `os.availableParallelism()` and sysfs. Requests to the local llama.cpp server use `node:http`, because `fetch` drops long requests after 300 s.
- Environment variables are encrypted for each phone, so they must stay small. That is why the app derives one tunnel key per replica slot from a single seed instead of taking one key per phone.
- Tunnel URL = `hex(sha256(compressed P-256 public key))[0:16]`, so you know it before deploying and need no callback server.
- 4 threads are fastest on most phones. Using all cores halves generation speed on big.LITTLE chips.
- Q4_0 models use llama.cpp's ARM repacked kernels and process prompts 25-45 % faster than Q4_K_M.
- Speculative decoding with a small draft model is slower on phone CPUs, so it is off (`VARIANTS`).
- Phones slow down under long sustained load (heat). For a service, run more than one phone.

## License

The code is MIT. The Qwen3.5 model weights are Apache-2.0 (GGUF conversions by unsloth).
