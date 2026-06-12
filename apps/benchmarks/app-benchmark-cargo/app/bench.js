// Entry point for the cargo / proot Shell-runtime deployment.
// Runs the shared workload and prints the result as JSON to stdout.
//
// Network reporting is intentionally NOT done here: Node's fetch/undici is
// unreliable under proot. start.sh captures this stdout and POSTs it via curl.
// Human-readable logs go to stderr so stdout stays clean JSON.

const os = require("os");
const net = require("net");
const { runBenchmark } = require("./bench-core");

const SETUP_MS = process.env.SETUP_MS ? Number(process.env.SETUP_MS) : null;

// One JSON-RPC 2.0 call over the Acurast bridge (abstract Unix socket, one call
// per connection, newline-delimited). Resolves the `result`, or null on error.
function rpc(method, params) {
  return new Promise((resolve) => {
    const sockPath = process.env.BRIDGE_SOCKET;
    if (!sockPath) return resolve(null);
    const req = JSON.stringify({ jsonrpc: "2.0", method, params, id: "1" }) + "\n";
    let buf = "";
    const sock = net.createConnection("\0" + sockPath); // leading NUL = abstract ns
    sock.on("connect", () => sock.write(req));
    sock.on("data", (c) => {
      buf += c;
      if (buf.includes("\n")) {
        sock.end();
        try {
          resolve(JSON.parse(buf.split("\n")[0]).result);
        } catch (e) {
          console.error(`rpc ${method} parse failed:`, e.message);
          resolve(null);
        }
      }
    });
    sock.on("error", (e) => {
      console.error(`rpc ${method} failed:`, e.message);
      resolve(null);
    });
  });
}

const norm = (s) => (s || "").toLowerCase().replace(/^0x/, "");

// Resolve this device's identity from the bridge. Returns the p256 deviceKey and
// — by matching it against deployment_assignedProcessors (keyed by SS58 address)
// — the SS58 processorAddress, which is the SAME id node reports via
// _STD_.device.getAddress(). Best-effort: failures leave fields null.
async function getIdentity() {
  const pk = await rpc("signer_publicKey", [{ curve: "p256" }]);
  const deviceKey = pk && pk.publicKey ? pk.publicKey : null;

  let processorAddress = null;
  const procs = await rpc("deployment_assignedProcessors", []);
  if (procs && typeof procs === "object" && deviceKey) {
    // The response nests the map under a wrapper (e.g. {"processors": {"<ss58>":
    // {p256, ...}}}), so recurse and return the SS58-pattern key whose subtree
    // contains our p256 — NOT the wrapper key.
    const target = norm(deviceKey);
    const isSS58 = (k) => /^[1-9A-HJ-NP-Za-km-z]{46,49}$/.test(k);
    const find = (node) => {
      if (!node || typeof node !== "object") return null;
      for (const [k, v] of Object.entries(node)) {
        if (isSS58(k) && norm(JSON.stringify(v)).includes(target)) return k;
        const deep = find(v);
        if (deep) return deep;
      }
      return null;
    };
    processorAddress = find(procs);
    if (!processorAddress) console.error("deviceKey not found in assignedProcessors");
  }
  return { deviceKey, processorAddress };
}

async function main() {
  const { deviceKey, processorAddress } = await getIdentity();
  const bench = runBenchmark(1, process.env.BENCH_TMP);
  const num = (k) => (process.env[k] != null && process.env[k] !== "" ? Number(process.env[k]) : null);
  const payload = {
    environment: "cargo",
    deviceAddress: processorAddress, // SS58 address — same field/value as node
    deviceKey, // p256 pubkey from the bridge; stable per device
    setup_ms: SETUP_MS, // rootfs node install time, measured in start.sh
    // network benchmark, measured by curl in start.sh
    network: {
      throughput_mbps: num("NET_THROUGHPUT_MBPS"),
      download_ms: num("NET_DOWNLOAD_MS"),
      parallel_ms: num("NET_PARALLEL_MS"),
      parallel_count: num("NET_PARALLEL_COUNT"),
    },
    timestamp: Date.now(),
    hostname: os.hostname(),
    ...bench,
  };

  console.error(
    "cargo benchmark done, total_ms=" +
      payload.total_ms.toFixed(1) +
      " addr=" +
      (processorAddress || "?")
  );
  process.stdout.write(JSON.stringify(payload));
}

main();
