# Benchmark Report

Downloads benchmark reports from the webhook and builds a self-contained,
filterable HTML overview comparing the environments: `nodejs` (native runtime),
`cargo` (Node in proot), and `cargo-native` (Rust in proot). The renderer is
N-environment aware — any environment posting the same payload shape shows up
automatically (color + cards + bars + ratio + histogram + matrix).

## Usage

```bash
node download.js   # pull all reports from the webhook -> data.json
node build.js      # embed data.json into a standalone index.html
open index.html    # view (charts need internet for the Chart.js CDN)
```

Override the channel: `node download.js <HOOK_UUID>` or `HOOK=<uuid> node download.js`.

`download.js` drops local dev runs (`platform=darwin` / `*.local`) automatically.

## What it shows

- Summary cards: report counts, distinct devices, median totals, cargo/nodejs ratio, cargo setup time.
- Per-section bar chart (nodejs vs cargo) + per-section ratio chart.
- `total_ms` distribution histogram and cargo `setup_ms` histogram.
- Scatter of `total_ms` vs a selectable X-axis (RAM, any section, or setup).
- Per-environment Pearson correlation matrices (which sections move together,
  what drives total time).
- Sortable, filterable table of every report.
- Filters: environment, arch, node version, memory, and aggregate (median/mean/p90).

> CPU count is not used — `os.cpus()` returns 0 on processors.

## Device identity caveat

- **nodejs** reports a stable SS58 `deviceAddress` (from `_STD_.device.getAddress()`).
- **cargo** has no such API, so it now reports a `deviceKey` (p256 public key
  fetched from the Acurast bridge socket) as a stable per-device id.
- **IP is NOT a device id.** The nodejs data proves it: multiple distinct
  devices share a single IP (NAT). Don't dedup by IP.
- `deviceKey` (p256) and `deviceAddress` (SS58) are different key types, so they
  cannot be cross-linked between the two runtimes from this data alone.
