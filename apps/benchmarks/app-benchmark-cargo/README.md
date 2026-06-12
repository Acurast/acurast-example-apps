# Acurast Example App: Benchmark (cargo / proot Shell runtime)

Runs a Node.js workload inside the **Shell** runtime in an Ubuntu
`proot-distro` rootfs: `nodejs` is installed at startup, then the workload is
run with `node`. Companion to
[`app-benchmark-nodejs`](../app-benchmark-nodejs), which runs the **exact same
workload** (`app/bench-core.js`) in the native Acurast runtime. Deploy both and
compare to isolate the proot/rootfs overhead (syscall interception, filesystem
binds).

## What it measures

`app/bench-core.js` runs five micro-benchmarks and reports per-section + total
wall-clock time (ms):

| Section            | What it stresses                                        |
| ------------------ | ------------------------------------------------------- |
| `cpu_primes_ms`    | Pure integer CPU (trial-division prime counting)        |
| `crypto_sha256_ms` | Native crypto bindings (chained sha256)                 |
| `json_ms`          | JSON serialize/parse                                     |
| `file_io_ms`       | write/read/delete many small files — **proot hot spot** |
| `mem_ms`           | Allocate + fill + sum a 64 MB typed array               |

It additionally reports `setup_ms` — the time to `apt-get install nodejs`
inside the rootfs (the one-time bootstrap cost of the proot approach) — plus
`node_version`, `arch`, `cpus`, `cpu_model`, `total_mem_bytes`.

## How it works

- `acurast.json` declares one project, `benchmark-cargo`, with
  `runtime: "Shell"`, an Ubuntu `proot-distro` image (with `sha256`), and
  `entrypoint: start.sh`.
- `start.sh` sets up `PATH`/`HOME`/DNS, installs `nodejs` + `curl` (timing the
  install), runs `app/bench.js`, then **POSTs the result via `curl`**.
- `app/bench.js` `require`s the shared `app/bench-core.js`, runs it, and prints
  the JSON payload (tagged `environment: "cargo"`) to stdout.

> **Why curl, not Node `fetch`?** Node's `fetch`/undici is unreliable under
> proot (broken `getifaddrs` / network-interface enumeration). The other cargo
> examples in this repo report via `curl` or Python for the same reason. Node
> here does pure compute only — no network — and `curl` handles the POST.

## Setup

```bash
cp .env.example .env   # set ACURAST_MNEMONIC and WEBHOOK_URL
npm i
npm run deploy
```

`npm run deploy` runs `acurast deploy`, which uploads the `app/` directory and
submits the deployment.

## Notes

- Node is installed from **NodeSource (Node 24)** so the engine matches the
  native runtime and the comparison isolates proot overhead rather than a Node
  version difference. Change `NODE_MAJOR` in `start.sh` to use another version.
  NodeSource has no 32-bit `armhf` build for Node 24, so this fails loud on the
  few `arm` (not `arm64`) processors.
- For an apples-to-apples comparison with `app-benchmark-nodejs`, pin both
  projects to the same processor via `processorWhitelist`, or run replicas and
  compare distributions. Group webhook payloads by `deviceAddress` /
  `cpu_model` before comparing.
