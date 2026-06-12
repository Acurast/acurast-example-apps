# Acurast Example App: Benchmark (cargo-native / Rust in proot)

Runs the same benchmark workload as the Node deployments, but as **native
compiled Rust** inside the **Shell** runtime (Ubuntu `proot-distro` rootfs).
The Rust toolchain is installed and the program compiled at startup, then run.

Companions:
- [`app-benchmark-nodejs`](../app-benchmark-nodejs) — JS in the native Acurast runtime.
- [`app-benchmark-cargo`](../app-benchmark-cargo) — JS via Node inside proot.
- **this app** — native Rust inside proot.

Together they separate three effects: the runtime (native vs proot), the
language/engine (JS/V8 vs compiled Rust), and the proot bootstrap cost.

## What it measures

`app/src/main.rs` runs the same five sections as `bench-core.js` and reports
per-section + total time (ms). It is **std-only** (SHA-256 and the JSON work are
hand-written) so `cargo build` needs **no network** — only the apt toolchain.

| Section            | What it stresses                          |
| ------------------ | ----------------------------------------- |
| `cpu_primes_ms`    | Integer CPU (trial-division primes)       |
| `crypto_sha256_ms` | Hand-written SHA-256, chained             |
| `json_ms`          | String build + scan (stringify/parse-ish) |
| `file_io_ms`       | write/read/delete many small files        |
| `mem_ms`           | Allocate + fill + sum a 64 MB f64 buffer  |

It also reports `setup_ms` (toolchain install) and `build_ms` (compile) — the
two one-time proot costs — plus `arch` and `total_mem_bytes` (from
`/proc/meminfo`).

## How it works

- `acurast.json` declares `runtime: "Shell"`, an Ubuntu `proot-distro` image,
  and `entrypoint: start.sh`.
- `start.sh` installs `cargo` (+ curl) via apt, `cargo build --release`, runs
  the binary, and POSTs the JSON it prints via `curl`.
- `app/src/main.rs` prints the payload (tagged `environment: "cargo-native"`,
  `runtime: "rust"`) to stdout.

## Comparability caveats

- **Not apples-to-apples by design** — this is compiled native code vs a JS
  engine. Use it to see the *order of magnitude* difference, especially how
  proot's file-IO overhead compares when the compute itself is much faster.
- `json_ms` is an approximation: it builds the same JSON string and scans it,
  rather than using a real serializer (avoids a crate + network).
- Reports a `deviceKey` (p256 public key from the Acurast bridge, queried via
  std's abstract-socket support on Linux) — same identifier as the Node cargo
  app, so reports can be deduped per device.

## Setup

```bash
cp .env.example .env   # set ACURAST_MNEMONIC and WEBHOOK_URL
npm i
npm run deploy
```
