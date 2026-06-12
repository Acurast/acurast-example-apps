// Entry point for the NATIVE Acurast runtime deployment (Node.js v20).
// Runs the exact same shared workload as the cargo/proot deployment and POSTs
// results tagged environment="nodejs".
//
// No defensive error handling: if anything fails, let it throw so the Acurast
// runtime surfaces the error.

// require (not import) so webpack bundles the shared JS workload without
// pulling it through ts-loader / tsconfig rootDir constraints.
const { runBenchmark } = require("../app/bench-core.js");

declare const _STD_: any;

// WEBHOOK_URL comes from .env (no hardcoded channel). Append an env-specific
// subPath so reports are attributable per app (POST to .../<channel>/nodejs).
if (!process.env.WEBHOOK_URL) {
  throw new Error("WEBHOOK_URL not set — configure it in .env");
}
const WEBHOOK_URL = process.env.WEBHOOK_URL.replace(/\/$/, "") + "/nodejs";

// Network benchmark via fetch (the native runtime's HTTP). Best-effort: a
// network failure returns nulls rather than losing the compute report. The
// proot apps measure the same two things with curl.
async function networkBench() {
  const DL = "https://speed.cloudflare.com/__down?bytes=10000000"; // 10 MB
  const SMALL = "https://speed.cloudflare.com/__down?bytes=100000"; // 100 KB
  const PARALLEL = 20;
  try {
    const t0 = Date.now();
    const buf = await (await fetch(DL)).arrayBuffer();
    const downloadMs = Date.now() - t0;
    const throughputMbps = (buf.byteLength * 8) / 1e6 / (downloadMs / 1000);

    const p0 = Date.now();
    await Promise.all(
      Array.from({ length: PARALLEL }, () => fetch(SMALL).then((r) => r.arrayBuffer()))
    );
    const parallelMs = Date.now() - p0;

    return {
      throughput_mbps: Math.round(throughputMbps * 100) / 100,
      download_ms: downloadMs,
      parallel_ms: parallelMs,
      parallel_count: PARALLEL,
    };
  } catch (e: any) {
    console.log("network benchmark failed:", e?.message ?? e);
    return { throughput_mbps: null, download_ms: null, parallel_ms: null, parallel_count: null };
  }
}

async function main() {
  // _STD_.job.storageDir is the writable dir in the native sandbox (/tmp is not).
  const bench = runBenchmark(1, _STD_.job.storageDir);
  const network = await networkBench();

  const payload = {
    environment: "nodejs",
    deploymentId: _STD_.job.getId(),
    deviceAddress: _STD_.device.getAddress(),
    network,
    timestamp: Date.now(),
    ...bench,
  };

  console.log(JSON.stringify(payload, null, 2));

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log("report POST status:", res.status);
}

main();
