# Acurast Example App: Benchmark (Node.js / native runtime)

Runs a Node.js workload in the **native Acurast runtime** (Node.js v20) and
reports timings. Companion to
[`app-benchmark-cargo`](../app-benchmark-cargo), which runs the **exact same
workload** (`app/bench-core.js`) inside the cargo/proot Shell runtime. Deploy
both and compare to isolate the proot/rootfs overhead.

## What it measures

`app/bench-core.js` runs five micro-benchmarks and reports per-section + total
wall-clock time (ms):

| Section            | What it stresses                                        |
| ------------------ | ------------------------------------------------------- |
| `cpu_primes_ms`    | Pure integer CPU (trial-division prime counting)        |
| `crypto_sha256_ms` | Native crypto bindings (chained sha256)                 |
| `json_ms`          | JSON serialize/parse                                     |
| `file_io_ms`       | write/read/delete many small files                      |
| `mem_ms`           | Allocate + fill + sum a 64 MB typed array               |

It also reports `node_version`, `arch`, `cpus`, `cpu_model`, `total_mem_bytes`,
plus `deviceAddress` so results can be correlated per processor.

## How it works

- `acurast.json` declares one project, `benchmark-nodejs`, with
  `fileUrl: dist/bundle.js` and the default (native) runtime.
- `src/index.ts` `require`s the shared `app/bench-core.js` (webpack bundles it),
  runs it, and POSTs the result tagged `environment: "nodejs"` to `WEBHOOK_URL`.

## Setup

```bash
cp .env.example .env   # set ACURAST_MNEMONIC and WEBHOOK_URL
npm i
npm run deploy
```

## Apples-to-apples comparison

The nodejs and cargo deployments may be assigned to **different processors**, so
raw numbers aren't directly comparable across devices. To compare both on the
**same hardware**, pin both projects to the same processor via
`processorWhitelist` in each `acurast.json`, or run replicas and compare the
distributions. Group webhook payloads by `deviceAddress` / `cpu_model`, then
compare `results_ms` / `total_ms` against the `cargo` payloads.
