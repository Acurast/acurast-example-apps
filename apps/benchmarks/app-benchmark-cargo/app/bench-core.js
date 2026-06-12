// Shared benchmark workload. Pure JS, no external dependencies.
// Used by BOTH the native deployment (bundled via webpack) and the
// cargo/proot Shell deployment (run with `node bench.js`), so the exact same
// code runs in both environments and the only difference measured is the
// runtime / proot overhead.
//
// No error handling on purpose: if a section fails (e.g. a restricted syscall
// in the native sandbox), let it throw so the Acurast runtime reports it.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function time(fn) {
  const start = process.hrtime.bigint();
  fn();
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6;
}

// --- CPU: count primes below n via trial division (pure integer compute) ---
function primesBench(n) {
  let count = 0;
  for (let i = 2; i < n; i++) {
    let isPrime = true;
    for (let j = 2; j * j <= i; j++) {
      if (i % j === 0) {
        isPrime = false;
        break;
      }
    }
    if (isPrime) count++;
  }
  return count;
}

// --- Crypto: chained sha256 (exercises native crypto bindings) ---
function hashBench(iterations) {
  let buf = Buffer.alloc(1024, 7);
  for (let i = 0; i < iterations; i++) {
    buf = crypto.createHash("sha256").update(buf).digest();
  }
  return buf.toString("hex");
}

// --- JSON: serialize + parse loop ---
function jsonBench(iterations) {
  const obj = {
    a: 1,
    b: "hello world",
    c: [1, 2, 3, 4, 5],
    d: { nested: true, arr: new Array(50).fill(0).map((_, i) => i) },
  };
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    const s = JSON.stringify(obj);
    const o = JSON.parse(s);
    acc += s.length + o.c.length;
  }
  return acc;
}

// --- File IO: write/read/delete many small files. ---
// Where proot's syscall interception (open/stat/read/write/unlink) is expected
// to hurt the most relative to the native runtime.
// baseDir must be a writable directory: /tmp is NOT writable in the native
// Acurast sandbox (use _STD_.job.storageDir) and may not exist in the proot
// rootfs, so the caller passes the right path explicitly.
function fileIoBench(numFiles, baseDir) {
  const dir = fs.mkdtempSync(path.join(baseDir, "bench-"));
  const data = Buffer.alloc(4096, 42);
  for (let i = 0; i < numFiles; i++) {
    const f = path.join(dir, "f" + i);
    fs.writeFileSync(f, data);
    fs.readFileSync(f);
    fs.unlinkSync(f);
  }
  fs.rmdirSync(dir);
  return numFiles;
}

// --- Memory: allocate a typed array, fill it, sum it ---
function memBench(sizeMb) {
  const arr = new Float64Array((sizeMb * 1024 * 1024) / 8);
  for (let i = 0; i < arr.length; i++) arr[i] = i * 1.0001;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum;
}

// scale sizes the workload up/down; tmpDir is a writable dir for the file IO
// section (caller supplies the env-appropriate path).
function runBenchmark(scale = 1, tmpDir) {
  const results = {};
  results.cpu_primes_ms = time(() => primesBench(200000 * scale));
  results.crypto_sha256_ms = time(() => hashBench(200000 * scale));
  results.json_ms = time(() => jsonBench(200000 * scale));
  results.file_io_ms = time(() => fileIoBench(2000 * scale, tmpDir));
  results.mem_ms = time(() => memBench(64));

  const total = Object.values(results).reduce((a, b) => a + b, 0);

  return {
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    cpu_model: (os.cpus()[0] || {}).model,
    total_mem_bytes: os.totalmem(),
    scale,
    results_ms: results,
    total_ms: total,
  };
}

module.exports = { runBenchmark };
