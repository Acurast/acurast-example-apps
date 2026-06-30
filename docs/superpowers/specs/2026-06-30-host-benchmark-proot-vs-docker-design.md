# Host Benchmark: proot vs Docker (e.g. Hetzner)

**Date:** 2026-06-30
**Status:** Approved design, pre-implementation

## Goal

Run the existing Acurast benchmark workload two ways **on a single plain Linux box**
(e.g. a Hetzner VPS) and compare them:

- **proot** — native, via `proot-distro` (no Docker), mirroring how the Acurast Shell
  runtime runs.
- **docker** — the same workload in a container, the cloud-native baseline.

Results post to the **existing** webhook and render in the **existing** HTML report
(`apps/benchmarks/benchmark-report/`) alongside `node` / `cargo-node` / `cargo-rust`.

The story: proot's syscall interception taxes file I/O; Docker is near-native. Postgres
(file-I/O heavy) is where that gap should show most.

## Non-goals

- Not an Acurast deployment. These runners are plain shell scripts; no `acurast.json`,
  no CLI deploy, no bridge identity.
- Not changing the existing `node` / `cargo` / `cargo-native` apps or their results.

## Constraints

- **Storage:** target box has ~1–2 GB free. Use glibc-slim images, prune after runs.
  Peak disk stays roughly under 700 MB including the postgres scale-10 dataset.
- **Comparability:** proot and docker must measure the *same* way (same workload code,
  same network method, same pgbench params) so the only variable is the runtime.

## Directory layout

New: `apps/benchmarks/app-benchmark-host/`

```
bench-core.js     # identical copy of the shared JS workload (CPU/crypto/JSON/fileIO/mem)
bench.js          # wrapper: run workload, attach identity, print JSON to stdout
common.sh         # shared shell: net_benchmark (curl), pg_benchmark (pgbench),
                  #   read /etc/machine-id, POST result via curl, error reporting
run-proot.sh      # proot-distro ubuntu rootfs + NodeSource node 24 + postgresql, run in proot
run-docker.sh     # build image, run workload + pgbench in containers
Dockerfile        # FROM node:24-slim + curl + postgresql-client + bench files
run.sh            # run BOTH (proot then docker), prune each after (--keep to skip)
.env.example      # WEBHOOK_URL (required), HOST_LABEL (optional)
README.md
```

`run.sh` is the primary entry point; `run-proot.sh` / `run-docker.sh` run one side alone.

## Workload (reused)

`bench-core.js` is copied verbatim from `app-benchmark-cargo/app/bench-core.js` — same 5
sections (prime counting, chained SHA-256, JSON encode/decode, many-small-file I/O, 64 MB
memory fill), same `runBenchmark(scale, tmpDir)` signature. README notes it must be kept in
sync with the canonical copy (the `cargo` and `nodejs` apps already each carry their own
copy; this follows that existing pattern).

## Sections beyond the JS workload

### Network (curl, both runtimes)

Identical to `app-benchmark-cargo/app/start.sh`'s `net_benchmark`: download 10 MB for
throughput (Mbit/s), 20 parallel 100 KB requests for wall time. Done with `curl` in **both**
proot and docker so they are directly comparable (Node fetch is avoided; it is unreliable
under proot, and using it only in docker would break comparability). Reported under
`network: { throughput_mbps, download_ms, parallel_ms, parallel_count }`.

### Postgres (pgbench, both runtimes)

Standard `pgbench`, same params on both sides:

- **proot:** `apt install postgresql`, `initdb` a data dir in the rootfs, start as the
  `postgres` user, `pgbench -i -s 10`, then `pgbench -T 30`.
- **docker:** `postgres:16` container (server). pgbench run against it (`pgbench` from the
  postgres image / `postgresql-client`), same `-s 10` / `-T 30`.

Reported under `postgres: { tps, latency_ms, init_ms, scale, install_ms }`:
- `tps` — pgbench transactions/sec (higher is better)
- `latency_ms` — pgbench average latency
- `init_ms` — `pgbench -i` time (load/index of scale-10 data)
- `scale` — pgbench scale factor (10)
- `install_ms` — time to install/pull postgres (one-time, like setup)

## Identity / pairing

Hetzner boxes have no Acurast SS58 address. Instead:

- Read `/etc/machine-id` on the host → report as **`hostId`**, and also set it as
  `deviceAddress` so the existing report groups runs without code changes.
- `HOST_LABEL` env (falls back to `hostname`) → readable name in the table.
- proot and docker on the same box share the same `hostId` → auto-pair in the report
  (consistency/all-modes group by device id).

`bench.js` receives `HOST_ID` / `HOST_LABEL` via env (read in shell, passed in) and emits
them in the payload.

## Payload shape

Same envelope as the cargo app (`bench.js`), with the new fields:

```json
{
  "environment": "proot" | "docker",
  "hostId": "<machine-id>",
  "deviceAddress": "<machine-id>",
  "label": "<HOST_LABEL or hostname>",
  "setup_ms": <rootfs+node install ms (proot) | image build/pull ms (docker)>,
  "network": { "throughput_mbps", "download_ms", "parallel_ms", "parallel_count" },
  "postgres": { "tps", "latency_ms", "init_ms", "scale", "install_ms" },
  "timestamp", "hostname",
  "node_version", "platform", "arch", "cpus", "cpu_model", "total_mem_bytes",
  "scale", "results_ms": { ... }, "total_ms": <sum>
}
```

Posted to `${WEBHOOK_URL%/}/proot` and `${WEBHOOK_URL%/}/docker` respectively (per-env
subpath, mirroring the cargo app), so failures are attributable per runtime.

## Report changes (small, additive)

`benchmark-report/build.js`:
- Add `{ key: "proot", color: ... }` and `{ key: "docker", color: ... }` to `ENV_DEFS`.
- Add `proot` / `docker` to the `LABEL` map (and the header legend text).
- Extend `deviceId(r)` to also read `r.hostId` (fallback after the SS58/key fields).
- Add a **postgres** panel: tps (higher better) and latency (lower better) bar charts,
  mirroring the existing two network charts. Reads `r.postgres`.

`benchmark-report/download.js`: no change required — these runs are on Linux (pass the
`isLocal` filter) and carry a device id (`deviceAddress`/`hostId`), so they are kept.

Existing `node` / `cargo` / `cargo-native` data and code paths are untouched (the `ipnote`
and SS58 canonicalization only look at `nodejs` / `cargo`).

## Storage handling

- proot: ubuntu rootfs + node + postgresql ≈ 400–500 MB; scale-10 pg data ≈ 150 MB.
- docker: `node:24-slim` (~200 MB) + `postgres:16` (~150 MB).
- `run.sh` runs proot, prunes its rootfs (`proot-distro remove`), then runs docker, prunes
  images/volumes (`docker system prune`), keeping **peak** disk low rather than cumulative.
- `--keep` flag skips pruning for fast re-runs when disk allows.

## Error handling

Mirror `start.sh`: on a non-zero exit or empty workload output, POST a small error report
(`{ environment, status: "error", stage, exit, error }`) instead of an empty body, then
exit non-zero. Each major stage (rootfs setup, node install, pg setup, workload, network,
pgbench) logs to stderr; network and pgbench failures are best-effort (log + continue with
nulls) so a partial result is still useful.

## Running

```bash
cd apps/benchmarks/app-benchmark-host
cp .env.example .env          # set WEBHOOK_URL, optionally HOST_LABEL
./run.sh                      # runs proot then docker, prunes after each
# or one side:
./run-proot.sh
./run-docker.sh
```

Then refresh the report:

```bash
cd ../benchmark-report
node download.js && node build.js && open index.html
```

## Open decisions (resolved)

- Single dir with both runners (not two sibling app dirs). ✅
- `run.sh` prunes by default; `--keep` to skip. ✅
- Postgres via `pgbench` (standard TPS/latency), reported in a `postgres` object. ✅
- Network via curl in both runtimes for comparability. ✅
