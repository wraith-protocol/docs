// ============================================================
// Wraith Stealth Playground — scanner.js
// Pure client-side crypto engine: Web Crypto (SubtleCrypto) for
// hashing, hand-rolled Curve25519/ed25519 arithmetic, Stellar
// StrKey encoding, and a minimal XDR (ScVal) codec for parsing
// Horizon contract events exactly like the SDK's
// parseAnnouncementEvent. Zero third-party dependencies.
//
// This file contains no DOM access — the UI lives in playground.js.
// ============================================================

'use strict';

// ── Curve25519 field arithmetic ─────────────────────────────
// p = 2^255 - 19
const P = (2n ** 255n) - 19n;
const A24 = 121665n; // (A-2)/4 where A=486662

function fmod(x) {
  let r = x % P;
  if (r < 0n) r += P;
  return r;
}

function fadd(a, b) { return fmod(a + b); }
function fsub(a, b) { return fmod(a - b); }
function fmul(a, b) { return fmod(a * b); }

// Modular inverse via Fermat: a^(p-2) mod p
function finv(a) { return fpow(a, P - 2n); }

function fpow(base, exp) {
  base = fmod(base);
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = fmul(result, base);
    base = fmul(base, base);
    exp >>= 1n;
  }
  return result;
}

// ── X25519 scalar multiplication (Montgomery ladder) ────────
// Returns u-coordinate of scalar * point(u)
function x25519(scalar, u) {
  // Clamp scalar per RFC 7748
  const s = clampScalar(scalar);

  let x1 = u;
  let x2 = 1n, z2 = 0n;
  let x3 = u, z3 = 1n;
  let swap = 0n;

  for (let t = 254n; t >= 0n; t--) {
    const bit = (s >> t) & 1n;
    const xorSwap = swap ^ bit;
    swap = bit;

    // Conditional swap
    if (xorSwap === 1n) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }

    const A  = fadd(x2, z2);
    const AA = fmul(A, A);
    const B  = fsub(x2, z2);
    const BB = fmul(B, B);
    const E  = fsub(AA, BB);
    const C  = fadd(x3, z3);
    const D  = fsub(x3, z3);
    const DA = fmul(D, A);
    const CB = fmul(C, B);
    x3 = fpow(fadd(DA, CB), 2n);
    z3 = fmul(x1, fpow(fsub(DA, CB), 2n));
    x2 = fmul(AA, BB);
    z2 = fmul(E, fadd(AA, fmul(A24, E)));
  }

  if (swap === 1n) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }

  return fmul(x2, finv(z2));
}

function clampScalar(s) {
  // s is a bigint; clamp per RFC 7748 §5
  let c = s & ((1n << 255n) - 1n); // clear top bit
  c &= ~7n;                          // clear bottom 3 bits
  c |= (1n << 254n);                 // set bit 254
  return c;
}

// ── Ed25519 public key → X25519 public key (Montgomery) ─────
// Uses the birational map: u = (1 + y) / (1 - y)
// where y is the Edwards y-coordinate recovered from the
// compressed ed25519 public key byte string.
function edPubToMontgomery(edPubBytes) {
  // edPubBytes: 32-byte Uint8Array (little-endian y, sign bit in MSB)
  const arr = new Uint8Array(edPubBytes);
  const copy = new Uint8Array(arr);
  // The top bit encodes the sign of x; we only need y
  copy[31] &= 0x7f;
  // Decode y as little-endian bigint
  const y = bytesToBigintLE(copy);
  // Map to Montgomery u: u = (1 + y) / (1 - y) mod p
  const u = fmul(fadd(1n, y), finv(fsub(1n, y)));
  return bigintToBytesLE(u, 32);
}

// ── Ed25519 private seed → X25519 private scalar ────────────
// Per RFC 8032 / RFC 7748: expand seed with SHA-512, take
// lower 32 bytes, clamp.
async function edSeedToMontgomeryScalar(seedBytes) {
  const h = await sha512(seedBytes);
  const lower = h.slice(0, 32);
  // Clamp
  lower[0]  &= 248;
  lower[31] &= 127;
  lower[31] |= 64;
  return lower; // 32-byte little-endian scalar
}

// ── Byte / bigint helpers ────────────────────────────────────
function bytesToBigintLE(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    n = (n << 8n) | BigInt(bytes[i]);
  }
  return n;
}

function bigintToBytesLE(n, len) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('Odd hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function strToBytes(s) {
  return new TextEncoder().encode(s);
}

function bytesToBinaryString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function binaryStringToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  return btoa(bytesToBinaryString(bytes));
}

function base64ToBytes(b64) {
  return binaryStringToBytes(atob(b64));
}

// ── Web Crypto hashing ───────────────────────────────────────
async function sha256(...parts) {
  const data = concatBytes(...parts);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(buf);
}

async function sha512(data) {
  const buf = await crypto.subtle.digest('SHA-512', data);
  return new Uint8Array(buf);
}

// ── Wraith domain-separated helpers ─────────────────────────
async function computeViewTag(sharedSecret) {
  const h = await sha256(strToBytes('wraith:tag:'), sharedSecret);
  return h[0];
}

async function hashToScalar(sharedSecret) {
  // L = 2^252 + 27742317777372353535851937790883648493n
  const L = (2n ** 252n) + 27742317777372353535851937790883648493n;
  const h = await sha256(strToBytes('wraith:scalar:'), sharedSecret);
  // interpret as little-endian bigint, reduce mod L
  return bytesToBigintLE(h) % L;
}

// ── Stellar StrKey (G… address) encoding ────────────────────
// Inline CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF)
function crc16(data) {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= (byte << 8);
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}

// Base32 alphabet (RFC 4648)
const BASE32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHA[(value >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALPHA[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const lookup = Object.fromEntries([...BASE32_ALPHA].map((c, i) => [c, i]));
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str.toUpperCase()) {
    if (!(ch in lookup)) throw new Error(`Invalid base32 char: ${ch}`);
    value = (value << 5) | lookup[ch];
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// version byte for ed25519 public key = 0x30 (decimal 48) → 'G' prefix
const ED25519_PUBKEY_VERSION = 6 << 3; // 0x30

function pubKeyToStellarAddress(pubKeyBytes) {
  // payload = [version, ...pubKeyBytes]
  const payload = new Uint8Array(33);
  payload[0] = ED25519_PUBKEY_VERSION;
  payload.set(pubKeyBytes, 1);
  // append CRC-16 (little-endian)
  const crc = crc16(payload);
  const full = new Uint8Array(35);
  full.set(payload);
  full[33] = crc & 0xff;
  full[34] = (crc >> 8) & 0xff;
  return base32Encode(full);
}

function stellarAddressToPubKey(address) {
  const decoded = base32Decode(address);
  if (decoded.length !== 35) throw new Error('Bad StrKey length');
  // last 2 bytes = CRC (little-endian)
  const payload = decoded.slice(0, 33);
  const crcExpected = decoded[33] | (decoded[34] << 8);
  const crcActual   = crc16(payload);
  if (crcExpected !== crcActual) throw new Error('StrKey checksum mismatch');
  if (payload[0] !== ED25519_PUBKEY_VERSION) throw new Error('Not an ed25519 pubkey');
  return payload.slice(1); // 32 bytes
}

// ── Stealth meta-address decode ──────────────────────────────
// Format: "st:xlm:<64hex spendingPubKey><64hex viewingPubKey>"
function decodeStealthMetaAddress(metaAddr) {
  const prefix = 'st:xlm:';
  if (!metaAddr.startsWith(prefix)) throw new Error('Not a Stellar meta-address');
  const hex = metaAddr.slice(prefix.length);
  if (hex.length !== 128) throw new Error('Meta-address must be 128 hex chars after prefix');
  return {
    spendingPubKey: hexToBytes(hex.slice(0, 64)),
    viewingPubKey:  hexToBytes(hex.slice(64)),
  };
}

// ── X25519 shared secret ─────────────────────────────────────
// privateSeed: 32-byte Uint8Array (ed25519 seed)
// publicPub:   32-byte Uint8Array (ed25519 pubkey)
async function computeSharedSecret(privateSeed, publicPub) {
  // 1. Expand seed → X25519 private scalar (clamp via SHA-512 lower half)
  const privScalarBytes = await edSeedToMontgomeryScalar(privateSeed);
  const privScalar = bytesToBigintLE(privScalarBytes);

  // 2. Convert ed25519 public key → X25519 public key (Montgomery u-coord)
  const pubMont = edPubToMontgomery(publicPub);
  const pubU = bytesToBigintLE(pubMont);

  // 3. X25519 scalar mult
  const sharedU = x25519(privScalar, pubU);
  return bigintToBytesLE(sharedU, 32);
}

// ── Ed25519 key derivation ───────────────────────────────────
// ed25519 parameters
const ED_P  = P; // same prime
const ED_Q  = (2n ** 252n) + 27742317777372353535851937790883648493n; // group order
const ED_D  = fmod(-121665n * finv(121666n)); // d = -121665/121666 mod p
const ED_GY = 4n * finv(5n) % ED_P; // base point y
const ED_GX = (() => {
  // Recover x from y: x^2 = (y^2 - 1) / (d*y^2 + 1)
  const y2 = fmul(ED_GY, ED_GY);
  const num = fsub(y2, 1n);
  const den = fadd(fmul(ED_D, y2), 1n);
  const x2 = fmul(num, finv(den));
  let x = fpow(x2, (ED_P + 3n) / 8n);
  if (fmul(x, x) !== x2) x = fmul(x, fpow(2n, (ED_P - 1n) / 4n));
  if (x % 2n !== 0n) x = ED_P - x; // canonical positive x
  return x;
})();

// Extended twisted Edwards point: (X:Y:Z:T) with x=X/Z, y=Y/Z, T=XY/Z
function edPointAdd(P1, P2) {
  const [X1,Y1,Z1,T1] = P1;
  const [X2,Y2,Z2,T2] = P2;
  const A = fmul(fsub(Y1,X1), fsub(Y2,X2));
  const B = fmul(fadd(Y1,X1), fadd(Y2,X2));
  const C = fmul(fmul(2n, ED_D), fmul(T1, T2));
  const D = fmul(2n, fmul(Z1, Z2));
  const E = fsub(B, A);
  const F = fsub(D, C);
  const G = fadd(D, C);
  const H = fadd(B, A);
  return [fmul(E,F), fmul(G,H), fmul(F,G), fmul(E,H)];
}

function edPointDouble(P1) {
  return edPointAdd(P1, P1);
}

// Scalar mult: k * point, k is bigint
function edScalarMult(k, point) {
  let Q = [0n, 1n, 1n, 0n]; // identity
  let R = point;
  while (k > 0n) {
    if (k & 1n) Q = edPointAdd(Q, R);
    R = edPointDouble(R);
    k >>= 1n;
  }
  return Q;
}

// Compress ed25519 point to 32-byte pubkey
function edPointCompress(pt) {
  const [X, Y, Z] = pt;
  const zinv = finv(Z);
  const x = fmul(X, zinv);
  const y = fmul(Y, zinv);
  const out = bigintToBytesLE(y, 32);
  // Set sign bit (top bit of last byte) to low bit of x
  if (x & 1n) out[31] |= 0x80;
  return out;
}

// Decompress 32-byte ed25519 pubkey to extended point
function edPointDecompress(bytes) {
  const b = new Uint8Array(bytes);
  const signBit = (b[31] >> 7) & 1;
  const yCopy = new Uint8Array(b);
  yCopy[31] &= 0x7f;
  const y = bytesToBigintLE(yCopy);
  const y2 = fmul(y, y);
  const num = fsub(y2, 1n);
  const den = fadd(fmul(ED_D, y2), 1n);
  const x2 = fmul(num, finv(den));
  if (x2 === 0n) return [0n, y, 1n, 0n];
  let x = fpow(x2, (ED_P + 3n) / 8n);
  if (fmul(x, x) !== fmod(x2)) x = fmul(x, fpow(2n, (ED_P - 1n) / 4n));
  if (Number(x & 1n) !== signBit) x = ED_P - x;
  return [x, y, 1n, fmul(x, y)];
}

const ED_G = [ED_GX, ED_GY, 1n, fmul(ED_GX, ED_GY)];

function deriveStealthPubKey(spendingPubBytes, hashScalar) {
  const spendingPoint = edPointDecompress(spendingPubBytes);
  const hG = edScalarMult(hashScalar, ED_G);
  const stealthPoint = edPointAdd(spendingPoint, hG);
  return edPointCompress(stealthPoint);
}

// ── Canonical key derivation (mirrors SDK deriveStealthKeys) ─
// seedToScalar: expand 32-byte seed via SHA-512 lower half, clamp
async function seedToScalar(seedBytes) {
  const h = await sha512(seedBytes);
  const lower = h.slice(0, 32);
  lower[0]  &= 248;
  lower[31] &= 127;
  lower[31] |= 64;
  return bytesToBigintLE(lower);
}

async function seedToPubKey(seedBytes) {
  const scalar = await seedToScalar(seedBytes);
  return edPointCompress(edScalarMult(scalar, ED_G));
}

// signature: 64-byte Uint8Array (an ed25519 wallet signature).
// The 64 bytes are split into two domain-separated seeds:
//   spendingKey = SHA-256("wraith:spending:" || signature)
//   viewingKey  = SHA-256("wraith:viewing:"  || signature)
async function deriveStealthKeys(signature) {
  if (signature.length !== 64) {
    throw new Error(`Expected 64-byte ed25519 signature, got ${signature.length} bytes`);
  }
  const spendingSeed = await sha256(strToBytes('wraith:spending:'), signature);
  const viewingSeed  = await sha256(strToBytes('wraith:viewing:'), signature);
  const [spendingScalar, viewingScalar] = await Promise.all([
    seedToScalar(spendingSeed),
    seedToScalar(viewingSeed),
  ]);
  const [spendingPubKey, viewingPubKey] = await Promise.all([
    seedToPubKey(spendingSeed),
    seedToPubKey(viewingSeed),
  ]);
  return {
    spendingKey: spendingSeed,
    viewingKey: viewingSeed,
    spendingScalar,
    viewingScalar,
    spendingPubKey,
    viewingPubKey,
  };
}

// ── Stealth address generation (mirrors SDK generateStealthAddress) ─
// spendingPubBytes, viewingPubBytes: 32-byte ed25519 pubkeys
// ephemeralSeed: 32-byte ed25519 seed for the one-time ephemeral keypair
async function generateStealthAddress(spendingPubBytes, viewingPubBytes, ephemeralSeed) {
  const ephPubKey = await seedToPubKey(ephemeralSeed);
  const sharedSecret = await computeSharedSecret(ephemeralSeed, viewingPubBytes);
  const viewTag = await computeViewTag(sharedSecret);
  const hScalar = await hashToScalar(sharedSecret);
  const stealthPubKeyBytes = deriveStealthPubKey(spendingPubBytes, hScalar);
  const stealthAddress = pubKeyToStellarAddress(stealthPubKeyBytes);
  return {
    stealthAddress,
    ephemeralPubKey: ephPubKey,   // Uint8Array
    viewTag,                       // number 0-255
    hScalar,                       // bigint
    sharedSecret,                  // Uint8Array
    stealthPubKeyBytes,            // Uint8Array
  };
}

// ── Stealth private scalar (mirrors SDK deriveStealthPrivateScalar) ─
async function deriveStealthPrivateScalar(spendingScalar, viewingKeySeed, ephemeralPubKeyBytes) {
  const sharedSecret = await computeSharedSecret(viewingKeySeed, ephemeralPubKeyBytes);
  const hScalar = await hashToScalar(sharedSecret);
  return (spendingScalar + hScalar) % ED_Q;
}

// ── Core scan function ───────────────────────────────────────
const L = ED_Q;

async function scanAnnouncements(announcements, viewingKeySeed, spendingPubBytes, spendingScalar) {
  const matches = [];

  for (const ann of announcements) {
    try {
      const ephPubBytes = hexToBytes(ann.ephemeralPubKey);
      const metaBytes   = hexToBytes(ann.metadata);
      const announcedViewTag = metaBytes[0];

      // 1. Compute shared secret
      const shared = await computeSharedSecret(viewingKeySeed, ephPubBytes);

      // 2. Check view tag (fast filter: eliminates ~255/256 non-matches)
      const expectedTag = await computeViewTag(shared);
      if (expectedTag !== announcedViewTag) continue;

      // 3. Derive expected stealth address
      const hScalar = await hashToScalar(shared);
      const stealthPubBytes = deriveStealthPubKey(spendingPubBytes, hScalar);
      const expectedAddr = pubKeyToStellarAddress(stealthPubBytes);

      if (expectedAddr !== ann.stealthAddress) continue;

      // 4. Derive private scalar: (spendingScalar + hScalar) mod L
      const stealthPrivateScalar = (spendingScalar + hScalar) % L;

      matches.push({
        ...ann,
        stealthPubKeyBytes: stealthPubBytes,
        stealthPrivateScalar,
      });
    } catch (_) {
      // Malformed announcement — skip
    }
  }

  return matches;
}

// ── Minimal XDR (ScVal) codec ────────────────────────────────
// Encodes/decodes exactly the subset of ScVal used by the
// stealth-announcer contract events, byte-compatible with
// @stellar/stellar-sdk's ScVal (verified against its XDR output).
// Note: SCV_VEC and SCV_MAP are recursive, so per the XDR spec
// they sit behind an option pointer — a `present` bool precedes
// the array contents.

const SCV_U32     = 3;
const SCV_BYTES   = 13;
const SCV_SYMBOL  = 15;
const SCV_VEC     = 16;
const SCV_ADDRESS = 18;

function u32ToBytes(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0);
  return out;
}

function readU32(bytes, off) {
  return new DataView(bytes.buffer, bytes.byteOffset + off, 4).getUint32(0);
}

function padTo4(bytes) {
  const rem = bytes.length % 4;
  return rem === 0 ? new Uint8Array(0) : new Uint8Array(4 - rem);
}

function scvU32XDR(n) {
  return concatBytes(u32ToBytes(SCV_U32), u32ToBytes(n));
}

function scvBytesXDR(bytes) {
  return concatBytes(u32ToBytes(SCV_BYTES), u32ToBytes(bytes.length), bytes, padTo4(bytes));
}

function scvSymbolXDR(s) {
  const b = strToBytes(s);
  return concatBytes(u32ToBytes(SCV_SYMBOL), u32ToBytes(b.length), b, padTo4(b));
}

// ScAddress: account type 0, ed25519 pubkey type 0, 32-byte pubkey
function scvAddressXDR(pubKeyBytes) {
  return concatBytes(u32ToBytes(SCV_ADDRESS), u32ToBytes(0), u32ToBytes(0), pubKeyBytes);
}

function scvVecXDR(items) {
  return concatBytes(u32ToBytes(SCV_VEC), u32ToBytes(1), u32ToBytes(items.length), ...items);
}

// Decode one ScVal, returning { kind, value, next }.
function decodeScVal(bytes, off = 0) {
  const type = readU32(bytes, off);
  off += 4;
  switch (type) {
    case SCV_U32:
      return { kind: 'u32', value: readU32(bytes, off), next: off + 4 };
    case SCV_SYMBOL: {
      const len = readU32(bytes, off);
      off += 4;
      const str = new TextDecoder().decode(bytes.slice(off, off + len));
      return { kind: 'symbol', value: str, next: off + len + ((4 - (len % 4)) % 4) };
    }
    case SCV_BYTES: {
      const len = readU32(bytes, off);
      off += 4;
      const b = bytes.slice(off, off + len);
      return { kind: 'bytes', value: b, next: off + len + ((4 - (len % 4)) % 4) };
    }
    case SCV_VEC: {
      const present = readU32(bytes, off);
      off += 4;
      if (present !== 1) throw new Error('Missing SCV_VEC option pointer');
      const count = readU32(bytes, off);
      off += 4;
      const items = [];
      for (let i = 0; i < count; i++) {
        const item = decodeScVal(bytes, off);
        items.push(item);
        off = item.next;
      }
      return { kind: 'vec', value: items, next: off };
    }
    case SCV_ADDRESS: {
      const addrType = readU32(bytes, off);
      off += 4;
      if (addrType !== 0) throw new Error('Unsupported address type');
      const pkType = readU32(bytes, off);
      off += 4;
      if (pkType !== 0) throw new Error('Unsupported public key type');
      const pk = bytes.slice(off, off + 32);
      return { kind: 'address', value: pk, next: off + 32 };
    }
    default:
      throw new Error(`Unsupported ScVal type ${type}`);
  }
}

// ── Horizon event ↔ announcement ─────────────────────────────
// Parses a Horizon contract event exactly like the SDK's
// parseAnnouncementEvent:
//   topic[0] = event name (symbol, ignored)
//   topic[1] = schemeId (u32)
//   topic[2] = stealth address (address)
//   value    = vec [caller (address), ephemeralPubKey (bytes),
//                   viewTag (bytes)]
function parseHorizonEvent(event) {
  try {
    const topics = (event.topic || []).map((t) => decodeScVal(base64ToBytes(t)));
    if (topics.length < 3) return null;
    if (topics[1].kind !== 'u32' || topics[2].kind !== 'address') return null;

    const value = decodeScVal(base64ToBytes(event.value));
    if (value.kind !== 'vec' || value.value.length < 3) return null;
    const [caller, ephPub, viewTag] = value.value;
    if (caller.kind !== 'address' || ephPub.kind !== 'bytes' || viewTag.kind !== 'bytes') {
      return null;
    }

    return {
      schemeId: topics[1].value,
      stealthAddress: pubKeyToStellarAddress(topics[2].value),
      caller: pubKeyToStellarAddress(caller.value),
      ephemeralPubKey: bytesToHex(ephPub.value),
      metadata: bytesToHex(viewTag.value),
    };
  } catch (_) {
    return null;
  }
}

// Builds a Horizon-shaped contract event from a plain announcement.
function encodeHorizonEvent(announcement, opts = {}) {
  const contractId = opts.contractId || 'CCJLJ2QRBJAAKIG6ELNQVXLLWMKKWVN5O2FKWUETHZGMPAD4MHK7WVWL';
  const ledger = opts.ledger || 0;
  const closeTime = opts.ledgerCloseTime || new Date().toISOString();
  const id = ledger.toString(16).padStart(24, '0') + '0000000000000000';
  return {
    type: 'contract',
    contract_id: contractId,
    ledger,
    ledger_close_time: closeTime,
    id,
    paging_token: `${ledger}-0`,
    topic: [
      bytesToBase64(scvSymbolXDR('announce')),
      bytesToBase64(scvU32XDR(announcement.schemeId)),
      bytesToBase64(scvAddressXDR(stellarAddressToPubKey(announcement.stealthAddress))),
    ],
    value: bytesToBase64(scvVecXDR([
      scvAddressXDR(stellarAddressToPubKey(announcement.caller)),
      scvBytesXDR(hexToBytes(announcement.ephemeralPubKey)),
      scvBytesXDR(hexToBytes(announcement.metadata)),
    ])),
    _yours: true,
  };
}
