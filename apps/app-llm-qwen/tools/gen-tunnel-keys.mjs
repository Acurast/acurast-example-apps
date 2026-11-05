#!/usr/bin/env node
// Generates N P-256 tunnel identities (PKCS#8 DER, base64) and prints the fixed
// tunnel URL each one maps to: https://hex(sha256(compressed pubkey))[0:16] (8 bytes).<suffix>
// Usage: node tools/gen-tunnel-keys.mjs --new-seed <n> [suffix]   -> prints TUNNEL_SEED=... and the URL of each slot
//        node tools/gen-tunnel-keys.mjs --seed <TUNNEL_SEED> <n> [suffix]   -> the URLs of an existing seed
//        node tools/gen-tunnel-keys.mjs <n> [suffix]   -> prints TUNNEL_KEYS=... line
//        node tools/gen-tunnel-keys.mjs --urls <TUNNEL_KEYS> [suffix]
import { generateKeyPairSync, createPublicKey, createPrivateKey, createHash, randomBytes } from 'node:crypto';

// Deterministic per-slot key from one 32-byte seed (keeps the encrypted env tiny for big fleets):
// d = sha256(seed || "acurast-tunnel/<slot>/<i>") mod n, re-encoded as PKCS#8 with the public point.
const P256_N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
export function deriveTunnelKey(seedHex, slot) {
  let d = 0n; for (let i = 0; ; i++) { const h = createHash('sha256').update(Buffer.from(seedHex, 'hex')).update(Buffer.from(`acurast-tunnel/${slot}/${i}`)).digest(); d = BigInt('0x' + h.toString('hex')) % P256_N; if (d > 0n) break; }
  const dBuf = Buffer.from(d.toString(16).padStart(64, '0'), 'hex');
  const scalarOnly = Buffer.concat([Buffer.from('3041020100301306072a8648ce3d020106082a8648ce3d03010704273025020101' + '0420', 'hex'), dBuf]);
  const pubJwk = createPublicKey(createPrivateKey({ key: scalarOnly, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
  const full = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: dBuf.toString('base64url'), x: pubJwk.x, y: pubJwk.y }, format: 'jwk' });
  return full.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

export function urlForKey(b64, suffix = 'mainnet.acu.run') {
  const pub = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
  const jwk = pub.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url'), y = Buffer.from(jwk.y, 'base64url');
  const compressed = Buffer.concat([Buffer.from([y[31] & 1 ? 3 : 2]), x]);
  return `https://${createHash('sha256').update(compressed).digest('hex').slice(0, 16)}.${suffix}`;
}

if (process.argv[1] && process.argv[1].endsWith('gen-tunnel-keys.mjs')) {
  const a = process.argv.slice(2);
  if (a[0] === '--seed') { // --seed <hex> <n> [suffix]
    const suffix = a[3] || 'mainnet.acu.run'; for (let i = 0; i < Number(a[2] || 1); i++) console.log(`slot ${i}: ${urlForKey(deriveTunnelKey(a[1], i), suffix)}`);
  } else if (a[0] === '--new-seed') { // --new-seed <n> [suffix]
    const seed = randomBytes(32).toString('hex'); const suffix = a[2] || 'mainnet.acu.run';
    for (let i = 0; i < Number(a[1] || 1); i++) console.error(`slot ${i}: ${urlForKey(deriveTunnelKey(seed, i), suffix)}`);
    console.log(`TUNNEL_SEED=${seed}`);
  } else if (a[0] === '--urls') {
    const suffix = a[2] || 'mainnet.acu.run';
    a[1].split(',').forEach((k, i) => console.log(`slot ${i}: ${urlForKey(k, suffix)}`));
  } else {
    const n = Number(a[0] || 1), suffix = a[1] || 'mainnet.acu.run';
    const keys = [];
    for (let i = 0; i < n; i++) {
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      keys.push(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
    }
    keys.forEach((k, i) => console.error(`slot ${i}: ${urlForKey(k, suffix)}`));
    console.log(`TUNNEL_KEYS=${keys.join(',')}`);
  }
}
