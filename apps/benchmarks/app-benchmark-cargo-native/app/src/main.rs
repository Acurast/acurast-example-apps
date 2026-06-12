// Native (Rust) port of the benchmark workload, mirroring bench-core.js so the
// cargo-native deployment can be compared against the Node deployments.
//
// std-only on purpose: no external crates => `cargo build` needs no network
// (no crates.io fetch), only the toolchain. SHA-256 and the JSON work are
// implemented by hand for the same reason.
//
// No error handling: if a section fails, it panics and the Acurast runtime
// reports it (matches the "let it fail" approach of the Node apps).

use std::fs;
use std::hint::black_box;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

// Identity via the Acurast bridge (abstract-namespace Unix socket; std supports
// those on Linux, Rust 1.70+). One JSON-RPC call per connection. Best-effort:
// missing identity must not lose the perf report.
#[cfg(target_os = "linux")]
fn bridge_call(req: &str) -> Option<String> {
    use std::io::{Read, Write};
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::net::{SocketAddr, UnixStream};

    let name = std::env::var("BRIDGE_SOCKET").ok()?;
    let addr = SocketAddr::from_abstract_name(name.as_bytes()).ok()?;
    let mut stream = UnixStream::connect_addr(&addr).ok()?;
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.contains(&b'\n') {
            break;
        }
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

// This device's p256 public key — a stable per-device id (== deviceKey in the
// Node cargo app).
#[cfg(target_os = "linux")]
fn device_key() -> Option<String> {
    let s = bridge_call(
        "{\"jsonrpc\":\"2.0\",\"method\":\"signer_publicKey\",\"params\":[{\"curve\":\"p256\"}],\"id\":\"1\"}\n",
    )?;
    let key = s.split("\"publicKey\":\"").nth(1)?.split('"').next()?.to_string();
    if key.is_empty() { None } else { Some(key) }
}

// Match our p256 key against deployment_assignedProcessors (keyed by SS58
// address) to recover the SS58 processor address — the SAME id node reports via
// _STD_.device.getAddress(). String-scan rather than a JSON parser (std-only).
#[cfg(target_os = "linux")]
fn processor_address(device_key: &str) -> Option<String> {
    let s = bridge_call(
        "{\"jsonrpc\":\"2.0\",\"method\":\"deployment_assignedProcessors\",\"params\":[],\"id\":\"1\"}\n",
    )?;
    let needle = device_key.to_lowercase();
    let needle = needle.trim_start_matches("0x");
    let pos = s.to_lowercase().find(needle)?;
    // Our processor's object opened at the last `":{` (really the `{` of `:{`)
    // before our key; the SS58 address is the quoted token just before it.
    let head = &s[..pos];
    let brace = head.rfind(":{")?;
    let before = &head[..brace];
    let mut it = before.rsplit('"');
    let _ = it.next(); // trailing fragment after the key's closing quote
    let addr = it.next()?.to_string();
    if addr.is_empty() { None } else { Some(addr) }
}

#[cfg(not(target_os = "linux"))]
fn device_key() -> Option<String> {
    None
}
#[cfg(not(target_os = "linux"))]
fn processor_address(_device_key: &str) -> Option<String> {
    None
}

// ----------------------------- SHA-256 (std-only) -----------------------------
const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let bitlen = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bitlen.to_be_bytes());

    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g; g = f; f = e; e = d.wrapping_add(t1);
            d = c; c = b; b = a; a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a); h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c); h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e); h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g); h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for i in 0..8 {
        out[i * 4..i * 4 + 4].copy_from_slice(&h[i].to_be_bytes());
    }
    out
}

// ------------------------------- benchmarks ----------------------------------
fn primes_bench(n: u64) -> u64 {
    let mut count = 0u64;
    let mut i = 2u64;
    while i < n {
        let mut is_prime = true;
        let mut j = 2u64;
        while j * j <= i {
            if i % j == 0 {
                is_prime = false;
                break;
            }
            j += 1;
        }
        if is_prime {
            count += 1;
        }
        i += 1;
    }
    count
}

fn hash_bench(iterations: u64) -> [u8; 32] {
    let mut buf = vec![7u8; 1024];
    for _ in 0..iterations {
        buf = sha256(&buf).to_vec();
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&buf);
    out
}

// JSON: build a string and scan it back, mirroring stringify+parse work.
fn json_bench(iterations: u64) -> u64 {
    let arr: Vec<i32> = (0..50).collect();
    let arr_str = arr.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",");
    let mut acc: u64 = 0;
    for _ in 0..iterations {
        let s = format!(
            "{{\"a\":1,\"b\":\"hello world\",\"c\":[1,2,3,4,5],\"d\":{{\"nested\":true,\"arr\":[{}]}}}}",
            arr_str
        );
        // "parse": scan the whole string (touch every byte) like a tokenizer.
        let mut commas = 0u64;
        for &byte in s.as_bytes() {
            if byte == b',' {
                commas += 1;
            }
        }
        acc += s.len() as u64 + 5 + commas;
    }
    acc
}

fn file_io_bench(num_files: u64, base_dir: &str) -> u64 {
    let dir = PathBuf::from(base_dir).join(format!("bench-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let data = vec![42u8; 4096];
    for i in 0..num_files {
        let f = dir.join(format!("f{}", i));
        fs::write(&f, &data).unwrap();
        let _ = fs::read(&f).unwrap();
        fs::remove_file(&f).unwrap();
    }
    fs::remove_dir(&dir).unwrap();
    num_files
}

fn mem_bench(size_mb: usize) -> f64 {
    let len = (size_mb * 1024 * 1024) / 8;
    let mut arr = vec![0f64; len];
    for i in 0..len {
        arr[i] = (i as f64) * 1.0001;
    }
    let mut sum = 0f64;
    for i in 0..len {
        sum += arr[i];
    }
    sum
}

fn time<F: FnOnce()>(f: F) -> f64 {
    let start = Instant::now();
    f();
    start.elapsed().as_secs_f64() * 1000.0 // ms
}

fn total_mem_bytes() -> Option<u64> {
    let meminfo = fs::read_to_string("/proc/meminfo").ok()?;
    for line in meminfo.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let kb: u64 = rest.trim().trim_end_matches(" kB").trim().parse().ok()?;
            return Some(kb * 1024);
        }
    }
    None
}

fn env_num(key: &str) -> Option<i64> {
    std::env::var(key).ok().and_then(|v| v.parse().ok())
}

fn main() {
    let scale: u64 = env_num("BENCH_SCALE").unwrap_or(1).max(1) as u64;
    let tmp = std::env::var("BENCH_TMP").expect("BENCH_TMP must be set (writable dir)");

    // black_box prevents the optimizer from eliminating benchmarks whose
    // results are otherwise unused.
    let cpu_primes_ms = time(|| { black_box(primes_bench(black_box(200_000 * scale))); });
    let crypto_sha256_ms = time(|| { black_box(hash_bench(black_box(200_000 * scale))); });
    let json_ms = time(|| { black_box(json_bench(black_box(200_000 * scale))); });
    let file_io_ms = time(|| { black_box(file_io_bench(black_box(2_000 * scale), &tmp)); });
    let mem_ms = time(|| { black_box(mem_bench(black_box(64))); });

    let total_ms = cpu_primes_ms + crypto_sha256_ms + json_ms + file_io_ms + mem_ms;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();

    let setup_ms = env_num("BENCH_SETUP_MS").map(|v| v.to_string()).unwrap_or("null".into());
    let build_ms = env_num("BENCH_BUILD_MS").map(|v| v.to_string()).unwrap_or("null".into());
    let mem_bytes = total_mem_bytes().map(|v| v.to_string()).unwrap_or("null".into());

    // Normalize arch to match the Node payloads (Rust: aarch64 -> Node: arm64).
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    };

    let dk = device_key();
    let pa = dk.as_ref().and_then(|k| processor_address(k));
    let q = |o: Option<String>| o.map(|v| format!("\"{}\"", v)).unwrap_or("null".into());
    let device_key = q(dk);
    let processor_address = q(pa);

    // Network benchmark, measured by curl in start.sh (NET_* env). Raw numeric
    // or null.
    let env_jnum = |k: &str| match std::env::var(k) {
        Ok(v) if !v.is_empty() && v.parse::<f64>().is_ok() => v,
        _ => "null".to_string(),
    };
    let network = format!(
        "{{\"throughput_mbps\":{},\"download_ms\":{},\"parallel_ms\":{},\"parallel_count\":{}}}",
        env_jnum("NET_THROUGHPUT_MBPS"),
        env_jnum("NET_DOWNLOAD_MS"),
        env_jnum("NET_PARALLEL_MS"),
        env_jnum("NET_PARALLEL_COUNT")
    );

    // Print ONLY the JSON to stdout (start.sh POSTs it via curl). Same shape as
    // the Node payloads, with environment="cargo-native".
    println!(
        "{{\"environment\":\"cargo-native\",\"runtime\":\"rust\",\"deviceAddress\":{},\"deviceKey\":{},\"setup_ms\":{},\"build_ms\":{},\"network\":{},\"timestamp\":{},\"arch\":\"{}\",\"total_mem_bytes\":{},\"scale\":{},\"results_ms\":{{\"cpu_primes_ms\":{:.3},\"crypto_sha256_ms\":{:.3},\"json_ms\":{:.3},\"file_io_ms\":{:.3},\"mem_ms\":{:.3}}},\"total_ms\":{:.3}}}",
        processor_address, device_key, setup_ms, build_ms, network, timestamp, arch, mem_bytes, scale,
        cpu_primes_ms, crypto_sha256_ms, json_ms, file_io_ms, mem_ms, total_ms
    );

    eprintln!("cargo-native benchmark done, total_ms={:.1}", total_ms);
}
