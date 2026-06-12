#!/usr/bin/env node
// Downloads all benchmark reports from the webhook.watch public read API and
// writes them to data.json. Drops local dev/verification runs (darwin/.local).
//
// Usage: node download.js [HOOK_UUID]

const fs = require("fs");
const path = require("path");

const HOOK =
  process.argv[2] ||
  process.env.HOOK ||
  "bbce5194-741b-4e3b-b667-23108d910445"; // read uuid (from /view/<uuid>); the
// ingest token the apps POST to (in.webhook.watch/<token>) is different.
const BASE = `https://api.webhook.watch/hooks/${HOOK}`;

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.json();
}

async function listAll() {
  const rows = [];
  let cursor = null;
  do {
    const u = new URL(`${BASE}/requests`);
    u.searchParams.set("limit", "500");
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await getJson(u.toString());
    rows.push(...res.requests);
    cursor = res.nextCursor;
  } while (cursor);
  return rows;
}

function isLocal(b) {
  // darwin / *.local -> local Node dev run.
  // null total_mem_bytes -> not a real processor (e.g. cargo-native run on a
  // mac, where /proc/meminfo doesn't exist; real devices always report it).
  return (
    b.platform === "darwin" ||
    /\.local$/.test(b.hostname || "") ||
    b.total_mem_bytes == null
  );
}

async function main() {
  const meta = await listAll();
  console.log(`Found ${meta.length} request(s) on ${HOOK}`);

  const reports = [];
  for (const m of meta) {
    try {
      const full = await getJson(`${BASE}/requests/${m.id}`);
      const b = full.request.body;
      if (!b || !b.results_ms) continue; // not a benchmark payload
      reports.push({
        id: m.id,
        receivedAt: m.createdAt,
        ip: m.ip,
        country: m.country,
        ...b,
      });
    } catch (e) {
      console.error(`skip ${m.id}: ${e.message}`);
    }
  }

  const nonLocal = reports.filter((b) => !isLocal(b));
  // Require a device identifier (SS58 deviceAddress/processorAddress, or p256
  // deviceKey). Drops old pre-deviceKey cargo reports that can't be attributed.
  const real = nonLocal.filter((b) => b.deviceAddress || b.processorAddress || b.deviceKey);
  console.log(
    `Benchmark reports: ${reports.length} (kept ${real.length}, dropped ${
      reports.length - nonLocal.length
    } local + ${nonLocal.length - real.length} without device id)`
  );

  const byEnv = {};
  for (const r of real) byEnv[r.environment] = (byEnv[r.environment] || 0) + 1;
  console.log("By environment:", byEnv);

  const out = path.join(__dirname, "data.json");
  fs.writeFileSync(out, JSON.stringify(real, null, 2));
  console.log(`Wrote ${real.length} reports to ${out}`);
}

main().catch((e) => {
  console.error("download failed:", e.message);
  process.exit(1);
});
