# Acurast Runtime Benchmarks

A small study comparing the ways you can run code on an Acurast processor, using the **same
workload** in each. The goal: help you pick the right runtime for the *shape* of your job.

## The three runtimes

| Folder | Label | What runs | Where |
| ------ | ----- | --------- | ----- |
| [`app-benchmark-nodejs`](./app-benchmark-nodejs)         | **node**       | JavaScript | native Acurast runtime |
| [`app-benchmark-cargo`](./app-benchmark-cargo)           | **cargo-node** | JavaScript (your own Node) | Shell runtime, Ubuntu via proot |
| [`app-benchmark-cargo-native`](./app-benchmark-cargo-native) | **cargo-rust** | compiled Rust | Shell runtime, Ubuntu via proot |

All three run the identical compute workload: prime counting (CPU), chained SHA-256 (crypto),
JSON encode/decode, many small file read/write/delete (file I/O), and a 64 MB memory fill.
Each run reports per-section and total timings to a webhook.

Each run also includes a **network benchmark**: download throughput (10 MB → Mbit/s) and the
wall time to complete 20 parallel 100 KB requests. node measures this with `fetch`; the proot
apps use `curl` in `start.sh` (Node's fetch is unreliable under proot), so the two proot apps
are directly comparable and node is in the same ballpark. Reported under `network`.

The two proot apps also report their one-time bootstrap cost separately: `setup_ms` (install
Node / the Rust toolchain) and, for Rust, `build_ms` (compile).

All apps post to a per-env subpath of the same webhook
(`https://in.webhook.watch/<channel>/{nodejs,cargo,cargo-native}`); the device's SS58
`deviceAddress` is reported by all three so the same device links across runtimes.

## The report

[`benchmark-report/`](./benchmark-report) pulls every result from the webhook and builds a
self-contained, filterable HTML dashboard (charts, per-section comparison, distributions,
within-device consistency, sortable table).

```bash
cd benchmark-report
node download.js   # pull results from the webhook -> data.json
node build.js      # embed into a standalone index.html
open index.html
```

`download.js` keeps only valid benchmark results: it drops local dev runs, failed/empty
posts, and reports without a device identifier.

## Running the benchmarks

Each app deploys independently (needs a funded mnemonic; see each app's `.env.example`):

```bash
cd app-benchmark-nodejs       && cp .env.example .env && npm i && npm run deploy
cd app-benchmark-cargo        && cp .env.example .env && npm i && npm run deploy
cd app-benchmark-cargo-native && cp .env.example .env && npm i && npm run deploy
```

Each posts to its own webhook subpath (`/nodejs`, `/cargo`, `/cargo-native`) so results and
failures are attributable per app.

## Device identity

Results are deduplicated per device, not per IP (multiple devices share an IP via NAT). All
three runtimes report the **same SS58 processor address**, so the same physical device links
across runtimes:

- **node** reports it directly via `_STD_.device.getAddress()` (`deviceAddress`).
- **cargo-node / cargo-rust** recover it from the bridge: fetch this device's p256 key
  (`signer_publicKey`), then match it against `deployment_assignedProcessors` (keyed by SS58
  address) to find the matching address — reported in the same `deviceAddress` field. They
  also keep the p256 `deviceKey`.

To force the *same set* of devices to run all three benchmarks (cleanest comparison), set an
identical `processorWhitelist` (those SS58 addresses) in each app's `acurast.json`.

## Findings

Short version (paired, same 16 devices ran all three — median ratio vs native node):

- **cargo-node (your own Node in proot): ~1.66× slower.** Same V8, so crypto/JSON/memory are
  ~equal; the cost is proot's file I/O (~3.6×) and CPU (~1.5×). Use it for the environment,
  not for speed.
- **cargo-rust: ~0.85× (faster).** Huge wins on crypto (~7×) and JSON (~12×), roughly ties on
  integer CPU, but pays the same proot file-I/O tax (~3×) and a ~90 s build+toolchain cost.
- **Native `node` is the right default** for short, simple, or file-I/O-heavy jobs — zero
  startup and faster than proot-Node for the same code.

An earlier draft compared different devices per runtime and reached the opposite conclusion;
the numbers above are the corrected, same-device comparison.

The full write-up, with numbers and caveats, is in [`benchmark-report/BLOG.md`](./benchmark-report/BLOG.md).

## Caveats

- Per-device the benchmark is very stable (run-to-run variation <1%), so differences are real
  signal — but each runtime was measured on a *different* set of processors, so cross-runtime
  totals are directional, not exact.
- It's a microbenchmark; the Rust JSON section is a hand-rolled approximation (no serializer
  crate, to keep the build network-free).
