# Host Benchmark: proot vs Docker (e.g. Hetzner)

**Date:** 2026-06-30 (rev 2026-07-01)
**Status:** Approved design, pre-implementation

## Goal

On a **single plain Linux box** (e.g. a Hetzner VPS), run two benchmark workloads two ways
and compare — **proot** (native, via `proot-distro`, mirroring the Acurast Shell runtime)
vs **docker** (container, the cloud-native baseline):

1. **JS micro-benchmark** — the existing `bench-core.js` (CPU / crypto / JSON / file-I/O /
   memory + a curl network probe). Measures raw runtime overhead. Posts to the existing
   webhook, renders in the existing report (`apps/benchmarks/benchmark-report/`).
2. **Postgres benchmark** — the proven `pg-benchmark.sh` (pgbench matrix + host/PG
   fingerprint). Measures DB performance, where proot's syscall/file-I/O tax should bite
   hardest. Uses the script's own JSON/table output + webhook POST (no new report code).

The DB comparison is really about the **server**: postgres running inside proot vs inside
docker. `pg-benchmark.sh` is a pure client and already fingerprints `sandbox_proot` /
`sysv_shm`, so it is purpose-built for this.

## Non-goals

- Not an Acurast deployment. Plain shell scripts; no `acurast.json`, no CLI deploy, no
  bridge identity.
- Not changing the existing `node` / `cargo` / `cargo-native` apps or their results.
- No new HTML report for postgres — rely on `pg-benchmark.sh`'s existing output + webhook.

## Constraints

- **Storage:** target box has ~1–2 GB free. glibc-slim images, prune after runs, and a
  **reduced pgbench scale** (`SCALE=10` ≈ 150 MB, not the script default 50 ≈ 750 MB).
  Peak disk stays roughly under 700 MB.
- **Comparability:** proot and docker measure the *same* way — same JS workload code, same
  curl network method, same vendored `pg-benchmark.sh` and same pgbench params — so the only
  variable is the runtime. Client runs co-located with the server in both cases (inside
  proot; inside the postgres container via `docker exec`).

## Directory layout

New: `apps/benchmarks/app-benchmark-host/`

```
bench-core.js         # identical copy of the shared JS workload
bench.js              # wrapper: run workload, attach identity, print JSON to stdout
common.sh             # shared shell: net_benchmark (curl), read /etc/machine-id,
                      #   POST result via curl, error reporting
pg-benchmark.sh       # VENDORED VERBATIM from the user's proven script (pgbench client)
sysv_shm_override.c   # copied from app-cargo-postgres (proot postgres needs the SysV shim)
Dockerfile            # FROM node:24-slim + curl (for the JS-bench container)
run-proot.sh          # JS bench in proot  + postgres server in proot  + pg-benchmark.sh
run-docker.sh         # JS bench in docker + postgres:16 container     + pg-benchmark.sh
run.sh                # run BOTH sides (proot then docker), prune each after (--keep to skip)
.env.example          # WEBHOOK_URL, HOST_LABEL, pg tunables (SCALE, DURATION, CLIENTS)
README.md
```

`run.sh` is the primary entry point; `run-proot.sh` / `run-docker.sh` run one side alone.

## Part 1 — JS micro-benchmark (reused)

`bench-core.js` copied verbatim from `app-benchmark-cargo/app/bench-core.js` (same 5
sections, same `runBenchmark(scale, tmpDir)`). README notes it must be kept in sync (the
`cargo` and `nodejs` apps already each carry their own copy — this follows that pattern).

`bench.js` mirrors the cargo wrapper but replaces Acurast bridge identity with host
identity (see Identity). Network probe = curl, in **both** runtimes (identical to
`app-benchmark-cargo/app/start.sh`'s `net_benchmark`) for comparability.

- **proot:** `proot-distro` ubuntu rootfs + NodeSource node 24; run `node bench.js` inside.
- **docker:** `node:24-slim` (+curl) image; `docker run --rm` `node bench.js`.

Posts to `${WEBHOOK_URL%/}/proot` and `${WEBHOOK_URL%/}/docker`, `environment: "proot" |
"docker"`, same payload envelope as the cargo app (`results_ms`, `total_ms`, `network`,
`setup_ms`, cpu/mem info) plus identity fields.

### Payload (JS bench)

```json
{
  "environment": "proot" | "docker",
  "hostId": "<machine-id>", "deviceAddress": "<machine-id>",
  "label": "<HOST_LABEL or hostname>",
  "setup_ms": <rootfs+node install (proot) | image build/pull (docker)>,
  "network": { "throughput_mbps", "download_ms", "parallel_ms", "parallel_count" },
  "timestamp", "hostname",
  "node_version", "platform", "arch", "cpus", "cpu_model", "total_mem_bytes",
  "scale", "results_ms": { ... }, "total_ms": <sum>
}
```

## Part 2 — Postgres benchmark (vendored script)

`pg-benchmark.sh` is vendored **verbatim** (it is proven and self-describing: host
fingerprint, PG tuning knobs, server-side CPU micro-bench, pgbench read-only + read-write
matrix over a client sweep, JSON + human table, optional webhook POST). The runners do NOT
reimplement it — they only **stand up a postgres server** each way and invoke the script as
a co-located client with the right libpq env vars and `LABEL`.

### Bringing up the server

- **proot:** in the same `proot-distro` rootfs — `apt install postgresql`, compile
  `sysv_shm_override.c` (postgres needs a SysV shm interlock that proot blocks; the shim is
  the same technique as `app-cargo-postgres`), `initdb`, start postgres on a unix socket in
  `/tmp` as the `postgres` user, then run `pg-benchmark.sh` inside proot with
  `LABEL=proot`, `PGHOST=/tmp`. (The getifaddrs shim from app-cargo-postgres is NOT needed —
  no tunnel/network interface enumeration here, just a local socket.)
- **docker:** run `postgres:16` (server), wait until healthy, `docker cp pg-benchmark.sh`
  into it and `docker exec` it with `LABEL=docker` (the postgres image already ships `psql`
  + `pgbench`; ensure `python3` is present for the script's JSON escaping — `apt install`
  it in the container, or the script's `jstr` fallback). Client co-located with server, as
  in proot.

### Params & reporting

- Tunables via env (`.env.example`): `SCALE=10` (reduced for storage), `DURATION`, `CLIENTS`,
  identical for both runtimes.
- `pg-benchmark.sh` posts its own rich JSON to `${WEBHOOK_URL%/}/pg-proot` and
  `${WEBHOOK_URL%/}/pg-docker`, and prints its human table. Comparison = diff the two
  `LABEL`ed outputs. No new report builder.
- These payloads have no `results_ms`, so the JS-bench `download.js` already skips them —
  the two streams never collide even on the same hook.

## Identity / pairing (JS bench)

No Acurast SS58 address. Read `/etc/machine-id` → report as `hostId` and also as
`deviceAddress` so the existing report groups runs with no code change. `HOST_LABEL` (or
`hostname`) for the readable name. proot + docker on the same box share `hostId` → auto-pair.
`bench.js` gets `HOST_ID` / `HOST_LABEL` via env from the shell.

## Report changes (small, additive) — JS bench only

`benchmark-report/build.js`:
- Add `{ key: "proot" }` / `{ key: "docker" }` to `ENV_DEFS` (colors) and to `LABEL`; update
  the header legend.
- Extend `deviceId(r)` to also read `r.hostId` (fallback after the SS58/key fields).

`benchmark-report/download.js`: no change (Linux passes `isLocal`; has a device id; pg
payloads lack `results_ms` and are skipped).

Existing `node` / `cargo` / `cargo-native` data and code paths untouched.

## Storage handling

- proot rootfs + node + postgresql ≈ 400–500 MB; pgbench scale-10 data ≈ 150 MB.
- docker: `node:24-slim` (~200 MB) + `postgres:16` (~150 MB).
- `run.sh` runs the proot side, prunes it (`proot-distro remove`, drop pg data dir), then
  the docker side, prunes it (`docker system prune -f`, remove volumes) — keeping **peak**
  disk low, not cumulative. `--keep` skips pruning for fast re-runs.

## Error handling

Mirror `start.sh`: on non-zero/empty JS-workload output, POST a small error report
(`{ environment, status:"error", stage, exit, error }`) and exit non-zero. `pg-benchmark.sh`
already fails loud on connection/tool errors. Stages (rootfs, node, pg server bring-up,
workload, network, pgbench) log to stderr; network is best-effort (null on failure).

## Running

```bash
cd apps/benchmarks/app-benchmark-host
cp .env.example .env          # WEBHOOK_URL, optional HOST_LABEL, SCALE/DURATION/CLIENTS
./run.sh                      # proot then docker: JS bench + postgres bench, prune after each
# or one side:  ./run-proot.sh   |   ./run-docker.sh
```

Refresh the JS-bench report:

```bash
cd ../benchmark-report && node download.js && node build.js && open index.html
```

Postgres: compare the two `pg-benchmark.sh` JSON/table outputs (or their webhook subpaths).

## Resolved decisions

- Deliverable = **both** JS micro-benchmark and postgres. ✅
- Postgres = **vendor `pg-benchmark.sh` verbatim**; runners only stand up the server. ✅
- Postgres reporting = script output + webhook, `LABEL` per run; **no new report**. ✅
- Single dir, both runners; `run.sh` prunes by default (`--keep` to skip). ✅
- Network via curl in both runtimes. ✅
- Reduced `SCALE=10` for the storage-constrained box. ✅
