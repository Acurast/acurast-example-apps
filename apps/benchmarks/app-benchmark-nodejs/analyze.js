#!/usr/bin/env node
// Pulls benchmark reports from the webhook.watch public read API and prints a
// cargo-vs-nodejs comparison. Requires the channel to be public (Sharing tab).
//
// Usage:
//   node analyze.js                 # uses default HOOK below
//   node analyze.js <HOOK_UUID>     # override channel
//   HOOK=<uuid> node analyze.js
//
// Sections compared come straight from app/bench-core.js (results_ms + total_ms).

const HOOK =
  process.argv[2] ||
  process.env.HOOK ||
  "bbce5194-741b-4e3b-b667-23108d910445"; // read uuid (see /view/<uuid>)

const BASE = `https://api.webhook.watch/hooks/${HOOK}`;

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.json();
}

// Walk the cursor-paginated /requests endpoint, return all metadata rows.
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

function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function isLocal(b) {
  // Drop local dev/verification runs (not real processors).
  return b.platform === "darwin" || /\.local$/.test(b.hostname || "");
}

async function main() {
  const meta = await listAll();
  console.log(`Fetched ${meta.length} request(s) from ${HOOK}\n`);

  // Pull full bodies (the list endpoint omits them).
  const bodies = [];
  for (const m of meta) {
    try {
      const full = await getJson(`${BASE}/requests/${m.id}`);
      const b = full.request.body;
      if (b && b.results_ms) bodies.push(b);
    } catch (e) {
      console.error(`skip ${m.id}: ${e.message}`);
    }
  }

  const real = bodies.filter((b) => !isLocal(b));
  const dropped = bodies.length - real.length;
  if (dropped) console.log(`Ignored ${dropped} local (darwin/.local) report(s)\n`);

  const byEnv = {};
  for (const b of real) (byEnv[b.environment] ||= []).push(b);

  const SECTIONS = [
    "cpu_primes_ms",
    "crypto_sha256_ms",
    "json_ms",
    "file_io_ms",
    "mem_ms",
  ];

  // Per-environment median of each section + total.
  const summary = {};
  for (const [env, list] of Object.entries(byEnv)) {
    const s = { n: list.length };
    for (const sec of SECTIONS) s[sec] = median(list.map((b) => b.results_ms[sec]));
    s.total_ms = median(list.map((b) => b.total_ms));
    if (env === "cargo") s.setup_ms = median(list.map((b) => b.setup_ms ?? NaN));
    summary[env] = s;
  }

  for (const [env, s] of Object.entries(summary)) {
    console.log(`== ${env}  (n=${s.n}) ==`);
    for (const sec of SECTIONS) console.log(`  ${sec.padEnd(18)} ${s[sec].toFixed(1)} ms`);
    console.log(`  ${"total_ms".padEnd(18)} ${s.total_ms.toFixed(1)} ms`);
    if (s.setup_ms != null && !Number.isNaN(s.setup_ms))
      console.log(`  ${"setup_ms".padEnd(18)} ${s.setup_ms.toFixed(1)} ms`);
    console.log("");
  }

  // Side-by-side ratio (cargo / nodejs). >1 means cargo/proot slower.
  const c = summary.cargo;
  const n = summary.nodejs;
  if (c && n) {
    console.log("== cargo / nodejs ratio (>1 = proot slower) ==");
    for (const sec of [...SECTIONS, "total_ms"]) {
      const ratio = c[sec] / n[sec];
      console.log(`  ${sec.padEnd(18)} ${ratio.toFixed(2)}x`);
    }
  } else {
    console.log("Need both 'cargo' and 'nodejs' reports for a ratio comparison.");
  }
}

main().catch((e) => {
  console.error("analyze failed:", e.message);
  process.exit(1);
});
