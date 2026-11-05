'use strict';
// Qwen3.5 on Acurast — Node.js runtime (processor-integrated llama.cpp via _STD_.llama).
// Flow: info/proxy server on :8080 -> tunnel up -> download GGUF(s) -> thread sweep benchmark
// (pp/tg via /completion timings) -> serve the model behind the tunnel.
// Everything observable at https://<fixed-id>.mainnet.acu.run/info ; OpenAI API at /v1/chat/completions.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

// ---------- local stub (lets `node src/index.js` run on a dev box) ----------
if (typeof _STD_ === 'undefined') {
  const { spawn } = require('child_process');
  let child = null;
  global._STD_ = {
    env: process.env,
    app_info: { version: 'local' },
    job: { getId: () => ({ id: 'local' }), getSlot: () => Number(process.env.SLOT || 0), storageDir: process.env.STORAGE_DIR || path.resolve('./storage') },
    device: { getAddress: () => 'local' },
    llama: { server: {
      start: (argv, ok, err) => {
        child = spawn(process.env.LLAMA_SERVER || 'llama-server', argv, { stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('error', (e) => err(String(e)));
        child.on('exit', (c) => { child = null; ok(); });
      },
      stop: (ok) => { if (child) { child.kill('SIGTERM'); child.on('exit', () => ok()); } else ok(); },
    } },
    tunnel: { start: (spec, ok) => ok({ url: 'http://127.0.0.1:8080', clientId: 'local' }), stop: (ok) => ok() },
  };
  fs.mkdirSync(_STD_.job.storageDir, { recursive: true });
}

// ---------- config ----------
const env = (k, d) => { const v = (_STD_.env && _STD_.env[k]) ?? process.env[k]; return v === undefined || v === '' || v === 'none' ? d : v; };
const NETWORK = env('NETWORK', 'mainnet');
// Same relay lists as the other tunnel examples (app-tunnel/nodejs/src/environment.ts)
const RELAYS = {
  mainnet: [
    'relay-1.mainnet.acurast.com:4433', 'relay-mainnet-acurast.5elementsnodes.com:4433', 'acurast-mainnet-relay.dishich.com:4433',
    'relay-mainnet.el9-acurast.com:4433', 'mainnet-relay.vincent-acurast.xyz:4433', 'relay.acurast.rubynodes.io:4433',
    'acurast-relay.paradoxxllc.com:4433', 'tunnel-acurast.ultraops.dev:4433', 'acurast-mainnet-relay.icebergnodes.io:4433',
    'relay-mainnet.oulurecords.com:4433', 'acurast-relay-mainnet.certhum.com:4433', 'mainnet-relay.acurast.online:4433',
    'tunnel-mainnet.acurastpulse.com:4433', 'relay.mainnet.dposkingdom.com:4433',
  ],
  canary: [
    'relay-2.canary.acurast.com:4433', 'canary-relay.5elementsnodes.com:4433', 'relay.el9-acurast.com:4433',
    'canary-relay.vincent-acurast.xyz:4433', 'canary-relay.acurast.online:4433',
  ],
};
const DOMAIN_SUFFIX = env('DOMAIN_SUFFIX', NETWORK === 'canary' ? 'canary.acu.run' : 'mainnet.acu.run');
const MODEL_URL = env('MODEL_URL', 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_0.gguf');
const DRAFT_URL = env('DRAFT_URL', 'none'); // e.g. https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_0.gguf (measured net loss on CPU phones)
const PARALLEL = Number(env('PARALLEL', '2'));        // concurrent sequences per phone (weights are read once per step for all of them)
const KV_TYPE = env('KV_TYPE', 'q8_0');               // KV cache quant for the full-attention layers (needs flash attention)
const VARIANTS = env('VARIANTS', 'baseline,tuned'); // measured 2026-10-14: draft/ngram/mtp never beat baseline on these phones; opt in via VARIANTS // measured in order; the fastest generation wins and is served
const EXTRA_MODEL_URLS = env('BENCH_EXTRA_MODELS', '').split(',').map((s) => s.trim()).filter(Boolean);
const LLM_API_KEY = env('LLM_API_KEY', '');
const CTX_SIZE = Number(env('CTX_SIZE', '4096'));
const BENCH_THREADS = env('BENCH_THREADS', '4');
const BENCH_PP = Number(env('BENCH_PP', '512'));
const BENCH_TG = Number(env('BENCH_TG', '128'));
const LLAMA_EXTRA_ARGS = env('LLAMA_EXTRA_ARGS', '').split(' ').filter(Boolean);
const PROXY_PORT = Number(env('PROXY_PORT', '8080')), LLAMA_PORT = Number(env('LLAMA_PORT', '8082'));
const STORAGE = _STD_.job.storageDir;
const SLOT = _STD_.job.getSlot();
const TUNNEL_KEYS = env('TUNNEL_KEYS', '').split(',').filter(Boolean);
const TUNNEL_SEED = env('TUNNEL_SEED', '');
// Same derivation as tools/gen-tunnel-keys.mjs deriveTunnelKey(): one seed in the env instead of one PKCS#8 key per slot
function deriveTunnelKey(seedHex, slot) {
  const N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
  let d = 0n; for (let i = 0; ; i++) { const h = crypto.createHash('sha256').update(Buffer.from(seedHex, 'hex')).update(Buffer.from(`acurast-tunnel/${slot}/${i}`)).digest(); d = BigInt('0x' + h.toString('hex')) % N; if (d > 0n) break; }
  const dBuf = Buffer.from(d.toString(16).padStart(64, '0'), 'hex');
  const scalarOnly = Buffer.concat([Buffer.from('3041020100301306072a8648ce3d020106082a8648ce3d03010704273025020101' + '0420', 'hex'), dBuf]);
  const pubJwk = crypto.createPublicKey(crypto.createPrivateKey({ key: scalarOnly, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: dBuf.toString('base64url'), x: pubJwk.x, y: pubJwk.y }, format: 'jwk' }).export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

// ---------- state ----------
const state = {
  runtime: 'nodejs', variant: 'processor-integrated llama.cpp (_STD_.llama)', phase: 'boot', startedAt: new Date().toISOString(),
  slot: SLOT, deployment: safe(() => _STD_.job.getId()), processorVersion: _STD_.app_info.version,
  device: null, tunnel: null, downloads: [], llamaBuild: null, bench: [], serving: null, errors: [], logs: [],
};
function safe(f) { try { return f(); } catch (e) { return String(e); } }
function log(m) { const line = `${new Date().toISOString()} ${m}`; console.log(line); state.logs.push(line); if (state.logs.length > 400) state.logs.shift(); }
function fail(m) { log('ERROR ' + m); state.errors.push(m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- device info ----------
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function deviceInfo() {
  const cpus = os.cpus();
  // Android app sandbox: os.cpus()/proc/cpuinfo may be empty; fall back to availableParallelism / sysfs 'possible' ("0-7")
  let nproc = cpus.length;
  const possible = (readText('/sys/devices/system/cpu/possible') || readText('/sys/devices/system/cpu/present') || '').trim();
  if (!nproc) nproc = (typeof os.availableParallelism === 'function' && os.availableParallelism()) || 0;
  if (!nproc && /^0-(\d+)$/.test(possible)) nproc = Number(possible.split('-')[1]) + 1;
  const nprocKnown = nproc > 0; if (!nproc) nproc = 8;
  const maxFreq = Array.from({ length: nproc }, (_, i) => Number(readText(`/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_max_freq`)) || 0);
  const top = Math.max(...maxFreq, 0);
  const perfCores = top ? maxFreq.filter((f) => f >= 0.75 * top).length : Math.max(4, Math.floor(nproc / 2));
  const cpuinfo = readText('/proc/cpuinfo') || '';
  const features = (cpuinfo.match(/Features\s*:\s*(.*)/) || [])[1] || '';
  const hw = (cpuinfo.match(/Hardware\s*:\s*(.*)/) || [])[1] || '';
  const parts = [...new Set((cpuinfo.match(/CPU part\s*:\s*(0x[0-9a-f]+)/g) || []).map((s) => s.split(':')[1].trim()))];
  return {
    address: safe(() => _STD_.device.getAddress()), nproc, nprocKnown, cpuPossible: possible, cpuModel: cpus[0] && cpus[0].model, hardware: hw, cpuParts: parts,
    maxFreqKHz: maxFreq, perfCores, features: { dotprod: /asimddp/.test(features), i8mm: /i8mm/.test(features), sve: /\bsve\b/.test(features), sme: /\bsme\b/.test(features), bf16: /bf16/.test(features), raw: features },
    totalMemBytes: os.totalmem(), freeMemBytes: os.freemem(), kernel: os.release(), node: process.versions.node, arch: process.arch,
    storageDir: STORAGE,
  };
}

// ---------- download with resume ----------
async function download(url) {
  const name = decodeURIComponent(url.split('/').pop().split('?')[0]);
  const dest = path.join(STORAGE, name);
  const rec = { name, url, bytes: 0, seconds: 0, mbps: null, resumedFrom: 0, status: 'pending' };
  state.downloads.push(rec);
  const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  let total = 0;
  try { const head = await fetch(url, { method: 'HEAD', redirect: 'follow' }); total = Number(head.headers.get('content-length')) || 0; } catch (e) { log(`HEAD failed (${e.message}), downloading without size check`); }
  if (total && have === total) { rec.status = 'cached'; rec.bytes = total; log(`model cached: ${name} (${total} B)`); return dest; }
  rec.resumedFrom = have < total ? have : 0;
  const t0 = Date.now();
  const res = await fetch(url, { headers: rec.resumedFrom ? { Range: `bytes=${rec.resumedFrom}-` } : {}, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download ${name}: HTTP ${res.status}`);
  const append = res.status === 206;
  log(`downloading ${name}: ${total} B${append ? ` (resume from ${rec.resumedFrom})` : ''}`);
  rec.status = 'downloading';
  let got = 0; const counter = new (require('stream').Transform)({ transform(c, _e, cb) { got += c.length; rec.bytes = (append ? rec.resumedFrom : 0) + got; rec.seconds = (Date.now() - t0) / 1000; cb(null, c); } });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest, { flags: append ? 'a' : 'w' }));
  rec.seconds = (Date.now() - t0) / 1000; rec.mbps = +(got / 1e6 / rec.seconds).toFixed(2); rec.status = 'done';
  log(`downloaded ${name}: ${got} B in ${rec.seconds.toFixed(0)} s (${rec.mbps} MB/s)`);
  return dest;
}

// ---------- llama server control ----------
let serverExited = false;
const llamaStart = (argv) => new Promise((res, rej) => { serverExited = false; try { _STD_.llama.server.start(argv, () => { log('llama callback: completion (server exited)'); serverExited = true; res(); }, (e) => { log('llama callback error: ' + e); serverExited = true; rej(new Error(String(e))); }); } catch (e) { rej(e); } setTimeout(res, 1500); });
const llamaStop = () => new Promise((res) => { try { _STD_.llama.server.stop(() => res(), (e) => { log('llama stop error: ' + e); res(); }); } catch (e) { res(); } });
// node:http instead of fetch for the local llama-server: undici POSTs to the processor-integrated server fail ("fetch failed") in the Acurast runtime
function lreq(method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: LLAMA_PORT, method, path: p, headers: { ...authHeaders(), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) }, timeout: timeoutMs }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, text }); });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs} ms`))); req.on('error', reject);
    if (data) req.write(data); req.end();
  });
}
async function lget(p, timeoutMs = 5000) { return lreq('GET', p, null, timeoutMs); }
function authHeaders() { return LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {}; }

async function startServer(argv) {
  log(`starting llama-server: ${argv.filter((x) => x !== LLM_API_KEY).join(' ')}`);
  const t0 = Date.now();
  await llamaStart(argv);
  for (let i = 0; i < 600 && !serverExited; i++) {
    await sleep(1000);
    try { const h = await lget('/health'); if (h.status === 200 && h.json && h.json.status === 'ok') { const loadSeconds = (Date.now() - t0) / 1000; log(`llama-server ready in ${loadSeconds.toFixed(1)} s`); return { loadSeconds }; } } catch {}
  }
  const err = new Error(serverExited ? `llama-server exited after ${((Date.now() - t0) / 1000).toFixed(0)} s (unsupported flag, model or OOM)` : 'llama-server not healthy after 600 s');
  await llamaStop(); await sleep(2000); throw err;
}
// Optimization stages. Each is a complete argv; the bench measures them in order and serves the fastest one.
function buildVariants(modelPath, draftPath, threads) {
  const base = ['--model', modelPath, '--host', '127.0.0.1', '--port', String(LLAMA_PORT), '--threads', String(threads), ...(LLM_API_KEY ? ['--api-key', LLM_API_KEY] : []), '--jinja'];
  // batched slots (weights read once per step for all active sequences), all cores for prompt processing,
  // flash attention + q8_0 KV on the full-attention layers, prefix reuse for chat turns
  const tuned = [...base, '--ctx-size', String(CTX_SIZE * PARALLEL), '--parallel', String(PARALLEL), '-fa', 'on', '--cache-type-k', KV_TYPE, '--cache-type-v', KV_TYPE, '--cache-reuse', '256', ...LLAMA_EXTRA_ARGS];
  const all = {
    baseline: [...base, '--ctx-size', String(CTX_SIZE)],
    tuned,
    // speculative decoding with the 0.8B draft: current flag names first, pre-2026 names second (the phone's bundled build is of unknown vintage)
    'tuned+draft': draftPath ? [...tuned, '--model-draft', draftPath, '--spec-type', 'draft-simple', '--spec-draft-n-max', '8', '--spec-draft-n-min', '2', '--spec-draft-p-min', '0.6', '--threads-draft', String(threads)] : null,
    'tuned+draft-legacy': draftPath ? [...tuned, '--model-draft', draftPath, '--draft-max', '8', '--draft-min', '2', '--draft-p-min', '0.6', '--threads-draft', String(threads)] : null,
    // self-speculation from the model's own MTP head (only if the GGUF carries it) and draft-free n-gram speculation
    'tuned+mtp': [...tuned, '--spec-type', 'draft-mtp'],
    'tuned+ngram': [...tuned, '--spec-type', 'ngram-mod'],
    minimal: ['--model', modelPath, '--host', '127.0.0.1', '--port', String(LLAMA_PORT), '--ctx-size', String(CTX_SIZE), '--threads', String(threads), ...(LLM_API_KEY ? ['--api-key', LLM_API_KEY] : [])],
  };
  return VARIANTS.split(',').map((n) => n.trim()).filter((n) => all[n]).map((n) => ({ name: n, argv: all[n] }));
}

// ---------- benchmark via /completion timings ----------
const PROMPT_BASE = 'The quick brown fox jumps over the lazy dog while the committee reviews quarterly logistics, infrastructure budgets, and the long-term resilience of distributed compute networks running on mobile hardware. ';
function buildPrompt(tokensWanted) { let s = ''; let i = 0; while (s.length < tokensWanted * 5.6) { s += `${i++}. ${PROMPT_BASE}`; } return s; }
async function completion(prompt, nPredict, timeoutMs = 600000) {
  const r = await lreq('POST', '/completion', { prompt, n_predict: nPredict, cache_prompt: false, temperature: 0, samplers: ['temperature'] }, timeoutMs);
  if (r.status !== 200 || !r.json) throw new Error(`completion HTTP ${r.status}: ${(r.text || '').slice(0, 200)}`);
  return r.json;
}
const TG_PROMPT = 'Explain, for a curious teenager, how a mobile phone network hands a call over from one cell tower to the next while a car drives down a motorway, and why the call does not drop. Cover measurements, timing, and what can go wrong.';
async function benchConfig(modelName, threads, loadSeconds, variant = 'baseline') {
  const rec = { model: modelName, variant, threads, loadSeconds: +loadSeconds.toFixed(1), pp: null, tg: null, promptTokens: null, genTokens: null };
  await completion('Hello', 4); // warm-up
  const rp = await completion(buildPrompt(BENCH_PP), 1); // prompt processing on ~512 tokens
  const tp = rp.timings || {}; rec.promptTokens = tp.prompt_n; rec.pp = +(tp.prompt_per_second || 0).toFixed(2); rec.ppMs = Math.round(tp.prompt_ms || 0);
  const rg = await completion(TG_PROMPT, BENCH_TG); // generation on natural text
  const tg = rg.timings || {}; rec.genTokens = tg.predicted_n; rec.tg = +(tg.predicted_per_second || 0).toFixed(2); rec.tgMs = Math.round(tg.predicted_ms || 0);
  if (tg.draft_n != null) { rec.draftTokens = tg.draft_n; rec.draftAccepted = tg.draft_n_accepted; rec.draftAcceptRate = tg.draft_n ? +(tg.draft_n_accepted / tg.draft_n).toFixed(2) : null; }
  rec.freeMemBytes = os.freemem();
  log(`bench ${modelName} [${variant}] t=${threads}: pp ${rec.pp} tok/s (${rec.promptTokens} tok), tg ${rec.tg} tok/s (${rec.genTokens} tok)${rec.draftAcceptRate != null ? ` draft accept ${rec.draftAcceptRate}` : ''}`);
  state.bench.push(rec);
  return rec;
}
function threadCandidates() {
  const d = state.device; const set = new Set();
  for (const t of BENCH_THREADS.split(',')) { const v = t === 'all' ? d.nproc : t === 'perf' ? d.perfCores : Number(t); if (v > 0 && v <= Math.max(d.nproc, 8)) set.add(v); }
  if (!set.size) set.add(4);
  return [...set].sort((a, b) => a - b);
}

// ---------- proxy + info server (:8080 -> tunnel primary) ----------
// chat.html ships next to index.js (fileUrl: src); fall back to a pointer if it is missing
let CHAT_HTML = '<!doctype html><title>Qwen3.5 on Acurast</title><p>chat.html missing from bundle. API: POST /v1/chat/completions, status: GET /info</p>';
try { CHAT_HTML = fs.readFileSync(path.join(__dirname, 'chat.html'), 'utf8'); } catch (e) { log('chat.html not found: ' + e.message); }
function startProxy() {
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (u === '/' || u === '/chat') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...cors }); return res.end(CHAT_HTML); }
    if (u === '/info') { res.writeHead(200, { 'Content-Type': 'application/json', ...cors }); return res.end(JSON.stringify({ ...state, logs: undefined, uptimeSeconds: Math.round(process.uptime()), freeMemBytes: os.freemem() }, null, 2)); }
    if (u === '/logs') { res.writeHead(200, { 'Content-Type': 'text/plain', ...cors }); return res.end(state.logs.join('\n')); }
    if (req.method === 'OPTIONS' && state.phase !== 'ready') { res.writeHead(204, cors); return res.end(); }
    if (state.phase !== 'ready' && !/^\/(health|props|v1\/models|models)$/.test(u)) { res.writeHead(503, { 'Content-Type': 'application/json', ...cors }); return res.end(JSON.stringify({ error: 'model not ready', phase: state.phase, hint: 'GET /info' })); }
    const up = http.request({ host: '127.0.0.1', port: LLAMA_PORT, method: req.method, path: req.url, headers: req.headers }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
    up.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'llama-server unreachable', detail: String(e), phase: state.phase })); });
    req.pipe(up);
  });
  server.keepAliveTimeout = 65000;
  return new Promise((r) => server.listen(PROXY_PORT, '127.0.0.1', () => { log(`proxy listening on 127.0.0.1:${PROXY_PORT}`); r(server); }));
}

async function startTunnel() {
  const key = TUNNEL_SEED ? deriveTunnelKey(TUNNEL_SEED, SLOT) : TUNNEL_KEYS[SLOT];
  if (!key) { fail(`no TUNNEL_SEED / TUNNEL_KEYS entry for slot ${SLOT}`); return; }
  const spec = { serverAddrs: RELAYS[NETWORK], domainSuffix: DOMAIN_SUFFIX, localAddr: `127.0.0.1:${PROXY_PORT}`, primaryKey: { algorithm: 'Secp256r1', bytes: key }, acmeStaging: false };
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const info = await new Promise((res, rej) => _STD_.tunnel.start(spec, res, (e) => rej(new Error(String(e)))));
      state.tunnel = info; log(`tunnel up: ${JSON.stringify(info)}`); return;
    } catch (e) { fail(`tunnel start attempt ${attempt}: ${e.message}`); await sleep(15000); }
  }
}

// ---------- main ----------
async function main() {
  state.device = deviceInfo();
  log(`slot ${SLOT} on ${state.device.address} nproc=${state.device.nproc} perf=${state.device.perfCores} mem=${(state.device.totalMemBytes / 1e9).toFixed(1)} GB processor=${state.processorVersion}`);
  await startProxy();
  state.phase = 'tunnel'; await startTunnel();
  // The tunnel URL is public: never serve the model without a key (the proxy keeps /info up to show why).
  if (!LLM_API_KEY) { fail('LLM_API_KEY is not set; refusing to serve the model without an API key'); state.phase = 'failed'; return; }
  state.phase = 'download';
  const downloadRetry = async (u) => { let last; for (let i = 1; i <= 5; i++) { try { return await download(u); } catch (e) { last = e; fail(`download attempt ${i} ${u.split('/').pop()}: ${e.message}`); await sleep(15000 * i); } } throw last; };
  const mainModel = await downloadRetry(MODEL_URL);
  let draftModel = null;
  if (DRAFT_URL && DRAFT_URL !== 'none') { try { draftModel = await downloadRetry(DRAFT_URL); } catch (e) { fail(`draft model: ${e.message}`); } }
  const extras = [];
  for (const u of EXTRA_MODEL_URLS) { try { extras.push(await downloadRetry(u)); } catch (e) { fail(`extra model: ${e.message}`); } }

  state.phase = 'bench';
  const threads = threadCandidates();
  log(`benchmark: threads ${threads.join(',')}, variants ${VARIANTS} (pp ${BENCH_PP} / tg ${BENCH_TG})`);
  let best = null;
  for (const m of [mainModel, ...extras]) {
    for (const t of threads) {
      for (const v of buildVariants(m, draftModel, t)) {
        try {
          const { loadSeconds } = await startServer(v.argv);
          if (!state.llamaBuild) { const p = await lget('/props').catch(() => null); state.llamaBuild = p && p.json ? { build_info: p.json.build_info, model: p.json.model_path || p.json.model_alias } : null; log(`llama.cpp build: ${JSON.stringify(state.llamaBuild)}`); }
          const rec = await benchConfig(path.basename(m), t, loadSeconds, v.name);
          // prefer a batched-slots variant when it is within 5 % of the best single-stream speed (two users per phone for the same price)
          const score = rec.tg * (v.name === 'baseline' ? 1 : 1.05);
          if (m === mainModel && (!best || score > best.score)) best = { rec, argv: v.argv, variant: v.name, threads: t, score };
        } catch (e) { fail(`bench ${path.basename(m)} [${v.name}] t=${t}: ${e.message}`); state.bench.push({ model: path.basename(m), variant: v.name, threads: t, failed: String(e.message).slice(0, 120) }); }
        await llamaStop(); await sleep(2000);
      }
    }
  }
  for (const m of extras) { try { fs.unlinkSync(m); } catch {} }

  state.phase = 'serve';
  const serveArgv = best ? best.argv : buildVariants(mainModel, null, state.device.perfCores).find((v) => v.name === 'minimal')?.argv || ['--model', mainModel, '--host', '127.0.0.1', '--port', String(LLAMA_PORT), '--ctx-size', String(CTX_SIZE), '--threads', String(state.device.perfCores), ...(LLM_API_KEY ? ['--api-key', LLM_API_KEY] : [])];
  try {
    const { loadSeconds } = await startServer(serveArgv);
    state.serving = { model: path.basename(mainModel), draft: best && best.variant.includes('draft') ? path.basename(draftModel) : null, variant: best ? best.variant : 'minimal', threads: best ? best.threads : state.device.perfCores, ctxSize: CTX_SIZE, parallel: best && best.variant !== 'baseline' ? PARALLEL : 1, loadSeconds, apiKeyRequired: !!LLM_API_KEY, args: serveArgv.filter((x) => x !== LLM_API_KEY).join(' '), openai: `${state.tunnel ? state.tunnel.url : 'http://127.0.0.1:8080'}/v1/chat/completions` };
    state.phase = 'ready';
    log(`READY: ${JSON.stringify(state.serving)}`);
  } catch (e) { fail(`serve: ${e.message}`); state.phase = 'failed'; }
  setInterval(() => {}, 1 << 30); // keep alive for the execution window
}
process.on('SIGTERM', async () => { log('SIGTERM'); await llamaStop(); process.exit(0); });
main().catch((e) => { fail(`main: ${e.stack || e}`); state.phase = 'failed'; });
