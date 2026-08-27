// generate-fixtures.mjs
// Run: node scripts/playground/generate-fixtures.mjs
// Writes scripts/playground/fixtures.json — the demo recipient keys and a
// batch of Horizon-shaped contract events that the playground parses with
// the same code path the SDK uses (see parseAnnouncementEvent).
//
//   node scripts/playground/generate-fixtures.mjs            # write fixtures.json
//   node scripts/playground/generate-fixtures.mjs --check    # verify fixtures.json is in sync
//
// Uses the same algorithms as the Wraith SDK (inline, no SDK import)
// so the docs repo doesn't need the SDK installed at build time.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dirname, "fixtures.json");

// The stealth-announcer contract on Stellar testnet (from the SDK deployments).
const ANNOUNCER_CONTRACT_ID = "CCJLJ2QRBJAAKIG6ELNQVXLLWMKKWVN5O2FKWUETHZGMPAD4MHK7WVWL";

// ── Curve25519 field arithmetic ──────────────────────────────
const P  = (2n ** 255n) - 19n;
const A24 = 121665n;
const L  = (2n ** 252n) + 27742317777372353535851937790883648493n;

const fmod = (x) => { let r = x % P; return r < 0n ? r + P : r; };
const fadd = (a, b) => fmod(a + b);
const fsub = (a, b) => fmod(a - b);
const fmul = (a, b) => fmod(a * b);
function fpow(base, exp) {
  base = fmod(base);
  let r = 1n;
  while (exp > 0n) {
    if (exp & 1n) r = fmul(r, base);
    base = fmul(base, base);
    exp >>= 1n;
  }
  return r;
}
const finv = (a) => fpow(a, P - 2n);

// ── helpers ──────────────────────────────────────────────────
function bytesToBigintLE(b) {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}
function bigintToBytesLE(n, len) {
  const o = Buffer.alloc(len);
  for (let i = 0; i < len; i++) { o[i] = Number(n & 0xffn); n >>= 8n; }
  return o;
}
function hexToBytes(h) { return Buffer.from(h, "hex"); }
function bytesToHex(b) { return Buffer.from(b).toString("hex"); }
function concatBufs(...a) { return Buffer.concat(a.map((x) => Buffer.from(x))); }
function sha256(...parts) { return createHash("sha256").update(concatBufs(...parts)).digest(); }
function sha512(d) { return createHash("sha512").update(d).digest(); }

// ── ed25519 math ─────────────────────────────────────────────
const ED_D  = fmod(-121665n * finv(121666n));
const ED_GY = fmod(4n * finv(5n));
const ED_GX = (() => {
  const y2 = fmul(ED_GY, ED_GY), num = fsub(y2, 1n), den = fadd(fmul(ED_D, y2), 1n);
  const x2 = fmul(num, finv(den));
  let x = fpow(x2, (P + 3n) / 8n);
  if (fmul(x, x) !== x2) x = fmul(x, fpow(2n, (P - 1n) / 4n));
  if (x % 2n !== 0n) x = P - x;
  return x;
})();
const ED_G = [ED_GX, ED_GY, 1n, fmul(ED_GX, ED_GY)];

function edAdd(P1, P2) {
  const [X1, Y1, Z1, T1] = P1, [X2, Y2, Z2, T2] = P2;
  const A = fmul(fsub(Y1, X1), fsub(Y2, X2)), B = fmul(fadd(Y1, X1), fadd(Y2, X2));
  const C = fmul(fmul(2n, ED_D), fmul(T1, T2)), D = fmul(2n, fmul(Z1, Z2));
  const E = fsub(B, A), F = fsub(D, C), G = fadd(D, C), H = fadd(B, A);
  return [fmul(E, F), fmul(G, H), fmul(F, G), fmul(E, H)];
}
function edMul(k, pt) {
  let Q = [0n, 1n, 1n, 0n], R = pt;
  while (k > 0n) {
    if (k & 1n) Q = edAdd(Q, R);
    R = edAdd(R, R);
    k >>= 1n;
  }
  return Q;
}
function edCompress(pt) {
  const [X, Y, Z] = pt, zi = finv(Z), x = fmul(X, zi), y = fmul(Y, zi);
  const o = bigintToBytesLE(y, 32);
  if (x & 1n) o[31] |= 0x80;
  return o;
}
function edDecompress(b) {
  const c = Buffer.from(b);
  const sign = (c[31] >> 7) & 1;
  c[31] &= 0x7f;
  const y = bytesToBigintLE(c), y2 = fmul(y, y), num = fsub(y2, 1n), den = fadd(fmul(ED_D, y2), 1n);
  const x2 = fmul(num, finv(den));
  let x = fpow(x2, (P + 3n) / 8n);
  if (fmul(x, x) !== fmod(x2)) x = fmul(x, fpow(2n, (P - 1n) / 4n));
  if (Number(x & 1n) !== sign) x = P - x;
  return [x, y, 1n, fmul(x, y)];
}

// seedToScalar: expand 32-byte seed via SHA-512 lower half, clamp (RFC 8032)
function seedToScalar(seed) {
  const h = sha512(seed), a = h.slice(0, 32);
  a[0] &= 248;
  a[31] &= 127;
  a[31] |= 64;
  return bytesToBigintLE(a);
}
function seedToPubKey(seed) { return edCompress(edMul(seedToScalar(seed), ED_G)); }

// ── X25519 ───────────────────────────────────────────────────
function clamp(s) { let c = s & ((1n << 255n) - 1n); c &= ~7n; c |= (1n << 254n); return c; }
function x25519(scalar, u) {
  const s = clamp(scalar);
  let x1 = u, x2 = 1n, z2 = 0n, x3 = u, z3 = 1n, sw = 0n;
  for (let t = 254n; t >= 0n; t--) {
    const bit = (s >> t) & 1n, xs = sw ^ bit;
    sw = bit;
    if (xs === 1n) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
    const A = fadd(x2, z2), AA = fmul(A, A), B = fsub(x2, z2), BB = fmul(B, B), E = fsub(AA, BB);
    const C = fadd(x3, z3), D = fsub(x3, z3), DA = fmul(D, A), CB = fmul(C, B);
    x3 = fpow(fadd(DA, CB), 2n);
    z3 = fmul(x1, fpow(fsub(DA, CB), 2n));
    x2 = fmul(AA, BB);
    z2 = fmul(E, fadd(AA, fmul(A24, E)));
  }
  if (sw === 1n) { [x2, x3] = [x3, x2]; }
  return fmul(x2, finv(z2));
}
function edPubToMont(b) {
  const c = Buffer.from(b);
  c[31] &= 0x7f;
  const y = bytesToBigintLE(c), u = fmul(fadd(1n, y), finv(fsub(1n, y)));
  return bigintToBytesLE(u, 32);
}
function edSeedToMontScalar(seed) {
  const h = sha512(seed), a = h.slice(0, 32);
  a[0] &= 248;
  a[31] &= 127;
  a[31] |= 64;
  return a;
}
function sharedSecret(privateSeed, publicPub) {
  const priv = bytesToBigintLE(edSeedToMontScalar(privateSeed));
  const pubU = bytesToBigintLE(edPubToMont(publicPub));
  return bigintToBytesLE(x25519(priv, pubU), 32);
}
function viewTag(shared) { return sha256(Buffer.from("wraith:tag:"), shared)[0]; }
function hashToScalar(shared) {
  const h = sha256(Buffer.from("wraith:scalar:"), shared);
  return bytesToBigintLE(h) % L;
}

// ── Stellar StrKey ───────────────────────────────────────────
function crc16(data) {
  let c = 0xffff;
  for (const b of data) {
    c ^= (b << 8);
    for (let i = 0; i < 8; i++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1);
    c &= 0xffff;
  }
  return c;
}
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32enc(bytes) {
  let bits = 0, val = 0, o = "";
  for (const b of bytes) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; o += B32[(val >> bits) & 31]; }
  }
  if (bits > 0) o += B32[(val << (5 - bits)) & 31];
  return o;
}
function b32dec(str) {
  const lookup = Object.fromEntries([...B32].map((c, i) => [c, i]));
  let bits = 0, val = 0;
  const out = [];
  for (const ch of str.toUpperCase()) {
    if (!(ch in lookup)) throw new Error(`Invalid base32 char: ${ch}`);
    val = (val << 5) | lookup[ch];
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((val >> bits) & 0xff); }
  }
  return Buffer.from(out);
}
function pubToAddr(pub) {
  const p = Buffer.alloc(33);
  p[0] = 0x30;
  pub.copy(p, 1);
  const c = crc16(p), f = Buffer.alloc(35);
  p.copy(f);
  f[33] = c & 0xff;
  f[34] = (c >> 8) & 0xff;
  return b32enc(f);
}
function addrToPub(addr) {
  const d = b32dec(addr);
  if (d.length !== 35) throw new Error("Bad StrKey length");
  const payload = d.slice(0, 33);
  const crcExpected = d[33] | (d[34] << 8);
  const crcActual = crc16(payload);
  if (crcExpected !== crcActual) throw new Error("StrKey checksum mismatch");
  if (payload[0] !== 0x30) throw new Error("Not an ed25519 pubkey");
  return payload.slice(1);
}

// ── Minimal XDR (ScVal) encoder ──────────────────────────────
// Matches the encodings produced by @stellar/stellar-sdk's ScVal so the
// fixture events can be decoded by the SDK's parseAnnouncementEvent.
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}
function pad4(b) {
  const rem = b.length % 4;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(4 - rem);
}
function scv(type, body) { return Buffer.concat([u32(type), body]); }
function scvU32(n) { return scv(3, u32(n)); }
function scvBytes(b) { return scv(13, Buffer.concat([u32(b.length), b, pad4(b)])); }
function scvSymbol(s) { const b = Buffer.from(s, "utf8"); return scv(15, Buffer.concat([u32(b.length), b, pad4(b)])); }
// ScAddress: account type 0 + ed25519 pubkey type 0 + 32-byte pubkey
function scvAddress(edPub) { return scv(18, Buffer.concat([u32(0), u32(0), edPub])); }
// SCV_VEC (and SCV_MAP) are recursive and live behind an option pointer in
// the XDR spec, so the arm writes a `present` bool before the array itself.
function scvVec(items) {
  const parts = items.map((x) => Buffer.from(x));
  return scv(16, Buffer.concat([u32(1), u32(parts.length), ...parts]));
}

// ── Fixture generation ───────────────────────────────────────
// The demo recipient keys are derived the same way the SDK derives keys
// from a wallet signature: split a 64-byte signature into two
// domain-separated seeds, expand each into a scalar + public key.
const demoSignature = sha512(Buffer.from("wraith:demo:signature")); // 64 bytes
const spendingSeed  = sha256(Buffer.from("wraith:spending:"), demoSignature);
const viewingSeed   = sha256(Buffer.from("wraith:viewing:"), demoSignature);
const spendingScalar = seedToScalar(spendingSeed);
const viewingScalar  = seedToScalar(viewingSeed);
const spendingPub    = seedToPubKey(spendingSeed);
const viewingPub     = seedToPubKey(viewingSeed);

// A demo wallet the recipient "withdraws" to (any ordinary Stellar account).
const walletPub = seedToPubKey(sha256(Buffer.from("wraith:wallet:demo")));

const recipient = {
  signature: bytesToHex(demoSignature),
  spendingKey: bytesToHex(spendingSeed),
  viewingKey: bytesToHex(viewingSeed),
  spendingScalar: spendingScalar.toString(),
  viewingScalar: viewingScalar.toString(),
  spendingPubKey: bytesToHex(spendingPub),
  viewingPubKey: bytesToHex(viewingPub),
  metaAddress: `st:xlm:${bytesToHex(spendingPub)}${bytesToHex(viewingPub)}`,
  walletAddress: pubToAddr(walletPub),
};

// Generate 5 fixture announcements; indices 0 and 2 are "yours".
const YOURS_INDICES = new Set([0, 2]);

function makeAnnouncement(ephSeed, isYours) {
  const ephPub = edCompress(edMul(seedToScalar(ephSeed), ED_G));

  if (!isYours) {
    // noise: random stealth address, wrong view tag
    const noiseKey = sha256(ephSeed, Buffer.from("noise"));
    const noisePub = edCompress(edMul(seedToScalar(noiseKey), ED_G));
    const noiseAddr = pubToAddr(Buffer.from(noisePub));
    const noiseTag = sha256(Buffer.from("wraith:tag:"), noiseKey)[0];
    const meta = Buffer.alloc(32);
    meta[0] = noiseTag;
    return {
      schemeId: 1,
      stealthAddress: noiseAddr,
      caller: pubToAddr(Buffer.from(ephPub)),
      ephemeralPubKey: bytesToHex(ephPub),
      metadata: bytesToHex(meta),
      _yours: false,
    };
  }

  // shared secret = ephPriv * viewingPub (X25519)
  const shared = sharedSecret(ephSeed, viewingPub);
  const tag = viewTag(shared);
  const hScalar = hashToScalar(shared);
  const stealthPub = edCompress(edAdd(edDecompress(spendingPub), edMul(hScalar, ED_G)));
  const stealthAddr = pubToAddr(Buffer.from(stealthPub));
  const meta = Buffer.alloc(32);
  meta[0] = tag;

  return {
    schemeId: 1,
    stealthAddress: stealthAddr,
    caller: pubToAddr(Buffer.from(ephPub)),
    ephemeralPubKey: bytesToHex(ephPub),
    metadata: bytesToHex(meta),
    _yours: true,
  };
}

const seeds = [
  sha256(Buffer.from("eph:0")),
  sha256(Buffer.from("eph:1")),
  sha256(Buffer.from("eph:2")),
  sha256(Buffer.from("eph:3")),
  sha256(Buffer.from("eph:4")),
];

const announcements = seeds.map((s, i) => makeAnnouncement(s, YOURS_INDICES.has(i)));

// Wrap each announcement in the Horizon contract-event shape the SDK parses:
//   topic[0] = event name symbol, topic[1] = schemeId u32,
//   topic[2] = stealth address, value = vec [caller, ephPubKey, viewTag]
const BASE_LEDGER = 51234000;
function toEvent(ann, index) {
  const ledger = BASE_LEDGER + index;
  const id = ledger.toString(16).padStart(24, "0") + "0000000000000000";
  const closeTime = new Date(Date.UTC(2026, 7, 20 + index, 12, 0, 0)).toISOString();
  return {
    type: "contract",
    contract_id: ANNOUNCER_CONTRACT_ID,
    ledger,
    ledger_close_time: closeTime,
    id,
    paging_token: `${ledger}-${index}`,
    topic: [
      scvSymbol("announce").toString("base64"),
      scvU32(ann.schemeId).toString("base64"),
      scvAddress(addrToPub(ann.stealthAddress)).toString("base64"),
    ],
    value: scvVec([
      scvAddress(addrToPub(ann.caller)),
      scvBytes(hexToBytes(ann.ephemeralPubKey)),
      scvBytes(hexToBytes(ann.metadata)),
    ]).toString("base64"),
    _yours: ann._yours,
  };
}

const events = announcements.map(toEvent);

const fixtures = {
  // Demo wallet signature + the keys derived from it (canonical SDK flow).
  recipient,
  // The stealth-announcer contract these events come from (testnet).
  announcerContractId: ANNOUNCER_CONTRACT_ID,
  // Horizon contract events, exactly as consumed by parseAnnouncementEvent.
  events,
};

function format() { return JSON.stringify(fixtures, null, 2) + "\n"; }

const isCheck = process.argv.includes("--check");
if (isCheck) {
  let current = null;
  try { current = readFileSync(OUT_FILE, "utf8"); } catch { /* missing */ }
  if (current !== format()) {
    console.error(
      "fixtures.json is out of sync. Run `node scripts/playground/generate-fixtures.mjs` and commit the result.",
    );
    process.exit(1);
  }
  console.log("fixtures.json is in sync.");
  process.exit(0);
}

writeFileSync(OUT_FILE, format());

console.log("Wrote " + OUT_FILE);
console.log("");
console.log("=== RECIPIENT (demo signature -> keys) ===");
console.log("signature:         " + recipient.signature.slice(0, 24) + "…");
console.log("viewingKey (seed): " + recipient.viewingKey);
console.log("spendingScalar:    " + recipient.spendingScalar);
console.log("metaAddress:       " + recipient.metaAddress);
console.log("walletAddress:     " + recipient.walletAddress);
console.log("");
console.log("=== EVENTS ===");
for (const e of events) {
  console.log(`  ledger ${e.ledger}  yours=${e._yours}  topic[2]=${decodeAddrFromTopic(e.topic[2])}`);
}

function decodeAddrFromTopic(b64) {
  const buf = Buffer.from(b64, "base64");
  // ScVal type 18 (address) + account type + ed25519 type + 32-byte pubkey
  return pubToAddr(buf.subarray(12));
}
