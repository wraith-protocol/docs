// ============================================================
// Wraith Scanner Playground — scanner.js
// Pure client-side: Web Crypto (SubtleCrypto) for hashing,
// hand-rolled Curve25519 for X25519 DH. Zero third-party deps.
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
// viewingKeySeed: 32-byte Uint8Array (ed25519 seed)
// ephemeralPubKeyBytes: 32-byte Uint8Array (ed25519 pubkey)
async function computeSharedSecret(viewingKeySeed, ephemeralPubKeyBytes) {
  // 1. Expand seed → X25519 private scalar (clamp via SHA-512 lower half)
  const privScalarBytes = await edSeedToMontgomeryScalar(viewingKeySeed);
  const privScalar = bytesToBigintLE(privScalarBytes);

  // 2. Convert ed25519 public key → X25519 public key (Montgomery u-coord)
  const pubMont = edPubToMontgomery(ephemeralPubKeyBytes);
  const pubU = bytesToBigintLE(pubMont);

  // 3. X25519 scalar mult
  const sharedU = x25519(privScalar, pubU);
  return bigintToBytesLE(sharedU, 32);
}

// ── Ed25519 point addition for stealth pub key derivation ────
// We need: stealthPub = spendingPub + hashScalar * G
// Using the extended twisted Edwards coordinates.

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

// ── Fixture data ─────────────────────────────────────────────
// Deterministically generated from a known seed so the demo
// always works with the pre-filled demo keys.
//
// Recipient keys were derived as follows (see FIXTURE_KEYS below):
//   viewingKey  = SHA-256("wraith:viewing:demo")   (32-byte hex seed)
//   spendingKey = SHA-256("wraith:spending:demo")  (32-byte hex seed)
//   spendingPubKey and viewingPubKey derived from those seeds
//   spendingScalar = seedToScalar(spendingKey)
//
// Two of the five announcements are addressed to this recipient.
// The other three are noise (addressed to random keys).
//
// All values were pre-computed offline and are hardcoded here.

// Demo recipient keys — derived from SHA-256("wraith:viewing:demo") etc.
// (pre-computed by scripts/playground/generate-fixtures.mjs)
const DEMO_VIEWING_KEY_HEX  = 'c7d997718f19c4e368a3957f29c736a96a00c95795f36698f7ea9cd52a159cbd';
const DEMO_SPENDING_SCALAR  = 47238892582032075641309788249336400507171835695141794998383909413316810203216n;
const DEMO_SPENDING_PUB_HEX = '45e84a059a47ee5d6fb721dcdbb31cecd928161e24b1e789e85d1e0510c99e86';
const DEMO_VIEWING_PUB_HEX  = 'd25639f6da0834e32d912626fd59d01e79a126ff10a59d034d2e46124e1ca791';
const DEMO_META_ADDRESS     = `st:xlm:${DEMO_SPENDING_PUB_HEX}${DEMO_VIEWING_PUB_HEX}`;

// Fixture announcements (pre-computed by generate-fixtures.mjs).
// Entries 0 and 2 (_yours: true) match the demo keys above.
// Entries 1, 3, 4 are noise addressed to random keypairs.
const FIXTURE_ANNOUNCEMENTS = [
  {
    // Match #1 — ephemeral seed SHA-256("eph:0")
    schemeId:        1,
    stealthAddress:  'GCQBIIZ2XR654U7FPVYVDU5W6R4FJG7QRLLGU6IMOKAWK3ZPLXHPVAA6',
    caller:          'GALDGOMBLFBC2Z5V3KDSXWM6PL4SFNGOIRROK2A2HLHSEFDVELU54237',
    ephemeralPubKey: '1633398159422d67b5da872bd99e7af922b4ce4462e5681a3acf22147522e9de',
    metadata:        '0a00000000000000000000000000000000000000000000000000000000000000',
    _yours: true,
  },
  {
    // Noise #1 — ephemeral seed SHA-256("eph:1")
    schemeId:        1,
    stealthAddress:  'GBXQUML6RVKJLZJX2LWFQWR3AG2QUUS4YVMAQYDETXWLN7UKUXAWLGZI',
    caller:          'GBQ2PGGKW45GFBTI57YMYSS46UOVNB6JI674M5AQACAFHACJ4E3DUPPI',
    ephemeralPubKey: '61a798cab73a628668eff0cc4a5cf51d5687c947bfc674100080538049e1363a',
    metadata:        '8500000000000000000000000000000000000000000000000000000000000000',
    _yours: false,
  },
  {
    // Match #2 — ephemeral seed SHA-256("eph:2")
    schemeId:        1,
    stealthAddress:  'GCW452O47CQUS5L2RHJNRZNQLNFZDPPWWICC6KJMNYTVAPRW2RP6WLWA',
    caller:          'GBJBZJG3JDX2EV4CBW5PE7X5OQCQGDRA5LPFE23IAC4YF6QKI3F7BADU',
    ephemeralPubKey: '521ca4db48efa257820dbaf27efd7405030e20eade526b6800b982fa0a46cbf0',
    metadata:        '9c00000000000000000000000000000000000000000000000000000000000000',
    _yours: true,
  },
  {
    // Noise #2 — ephemeral seed SHA-256("eph:3")
    schemeId:        1,
    stealthAddress:  'GBG2TPIPQM3MMFMIIOUHJXZPMQ5FOB2DM2CTBYT4YOGZK5GCKFNAGOSI',
    caller:          'GDOFFZ6AIKS2RIKW65GOTSW7ZB2NUNCIMTJZFMECSTS4BTB6HF2YTELI',
    ephemeralPubKey: 'dc52e7c042a5a8a156f74ce9cadfc874da344864d392b08294e5c0cc3e397589',
    metadata:        '9500000000000000000000000000000000000000000000000000000000000000',
    _yours: false,
  },
  {
    // Noise #3 — ephemeral seed SHA-256("eph:4")
    schemeId:        1,
    stealthAddress:  'GCHMAU4TJ2HVT2PE4AOSVXA6IG2X7HZ56EWCK55BFLAIRY3E6NBX2LLA',
    caller:          'GCY3J75MGG2HVA7LJ6XIGUCTBHQAVIMQAUPZGTYF73LXJSXDOUQNZTMQ',
    ephemeralPubKey: 'b1b4ffac31b47a83eb4fae83505309e00aa190051f934f05fed774cae37520dc',
    metadata:        'fa00000000000000000000000000000000000000000000000000000000000000',
    _yours: false,
  },
];

// ── UI helpers ───────────────────────────────────────────────
function trunc(hex, n = 12) {
  return hex.length <= n * 2 ? hex : hex.slice(0, n) + '…' + hex.slice(-6);
}

function renderResults(matches, total, elapsedMs) {
  const container = document.getElementById('results');

  const bar = document.createElement('div');
  bar.className = 'status-bar';

  if (matches === null) {
    bar.innerHTML = `<span class="dot dot-err"></span><span>Error — see console for details.</span>`;
    container.innerHTML = '';
    container.appendChild(bar);
    return;
  }

  bar.innerHTML = `
    <span class="dot dot-done"></span>
    <span>Scanned <strong>${total}</strong> announcement${total !== 1 ? 's' : ''} in ${elapsedMs}ms — 
    <strong>${matches.length}</strong> match${matches.length !== 1 ? 'es' : ''} found.</span>`;

  container.innerHTML = '';
  container.appendChild(bar);

  if (matches.length === 0) {
    const none = document.createElement('div');
    none.className = 'no-match';
    none.textContent = 'No announcements matched these keys.';
    container.appendChild(none);
    return;
  }

  for (const m of matches) {
    const card = document.createElement('div');
    card.className = 'match-card';
    card.innerHTML = `
      <div class="tag">Match</div>
      <div class="kv-row">
        <span class="k">Stealth Address</span>
        <span class="v">${m.stealthAddress}</span>
      </div>
      <div class="kv-row">
        <span class="k">Ephemeral Pub Key</span>
        <span class="v">${m.ephemeralPubKey}</span>
      </div>
      <div class="kv-row">
        <span class="k">Stealth Pub Key (hex)</span>
        <span class="v">${bytesToHex(m.stealthPubKeyBytes)}</span>
      </div>
      <div class="kv-row">
        <span class="k">Stealth Private Scalar (decimal)</span>
        <span class="v" style="font-size:10px">${m.stealthPrivateScalar.toString()}</span>
      </div>`;
    container.appendChild(card);
  }
}

function showScanning(total) {
  const container = document.getElementById('results');
  container.innerHTML = `
    <div class="status-bar">
      <span class="dot dot-scanning"></span>
      <span>Scanning ${total} announcements…</span>
    </div>`;
}

function renderFixtureTable() {
  const table = document.getElementById('fixtureTable');
  table.innerHTML = `
    <thead>
      <tr>
        <th>#</th>
        <th>Stealth Address</th>
        <th>Ephemeral Pub Key</th>
        <th>View Tag</th>
        <th>Owner</th>
      </tr>
    </thead>`;
  const tbody = document.createElement('tbody');
  FIXTURE_ANNOUNCEMENTS.forEach((ann, i) => {
    const viewTag = parseInt(ann.metadata.slice(0, 2), 16);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${trunc(ann.stealthAddress, 8)}</td>
      <td>${trunc(ann.ephemeralPubKey, 8)}</td>
      <td>0x${viewTag.toString(16).padStart(2,'0')}</td>
      <td>${ann._yours
        ? '<span class="badge-yours">yours</span>'
        : '<span class="badge-other">other</span>'}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

// ── Input parsing helpers ────────────────────────────────────
function parseInputs() {
  const metaRaw    = document.getElementById('metaAddr').value.trim();
  const vkRaw      = document.getElementById('viewingKey').value.trim();
  const ssRaw      = document.getElementById('spendingScalar').value.trim();
  const errors = {};

  let viewingKey = null, spendingPubKey = null, spendingScalar = null;

  // Try to parse meta-address first
  if (metaRaw.startsWith('st:xlm:')) {
    try {
      const decoded = decodeStealthMetaAddress(metaRaw);
      spendingPubKey = decoded.spendingPubKey;
      // meta-address doesn't give us viewing key seed or spending scalar — user must supply separately
    } catch (e) {
      errors.metaAddr = e.message;
    }
  }

  // Parse viewing key seed
  if (vkRaw.length === 64) {
    try { viewingKey = hexToBytes(vkRaw); } catch (e) { errors.viewingKey = e.message; }
  } else if (vkRaw) {
    errors.viewingKey = 'Must be 64 hex chars (32 bytes)';
  } else {
    errors.viewingKey = 'Required';
  }

  // If no meta-address, spending pub is derived from viewing key + scalar later; user can also
  // supply it via meta-address. For the demo we require a meta-address OR we can use demo defaults.
  if (!spendingPubKey && metaRaw) {
    // already set error above or not a meta-address at all
    if (!metaRaw.startsWith('st:xlm:')) errors.metaAddr = 'Must start with st:xlm:';
  }

  // Parse spending scalar
  if (ssRaw) {
    try { spendingScalar = BigInt(ssRaw); } catch (e) { errors.spendingScalar = 'Must be a decimal integer'; }
  } else {
    errors.spendingScalar = 'Required';
  }

  return { viewingKey, spendingPubKey, spendingScalar, errors };
}

// ── Main scan handler ────────────────────────────────────────
document.getElementById('scanBtn').addEventListener('click', async () => {
  const btn = document.getElementById('scanBtn');

  // Clear previous field errors
  ['metaAddr','viewingKey','spendingScalar'].forEach(id => {
    document.getElementById(id).classList.remove('error');
  });

  const { viewingKey, spendingPubKey, spendingScalar, errors } = parseInputs();

  if (Object.keys(errors).length > 0) {
    // Highlight erroneous fields
    if (errors.metaAddr)        document.getElementById('metaAddr').classList.add('error');
    if (errors.viewingKey)      document.getElementById('viewingKey').classList.add('error');
    if (errors.spendingScalar)  document.getElementById('spendingScalar').classList.add('error');
    const container = document.getElementById('results');
    container.innerHTML = `
      <div class="status-bar">
        <span class="dot dot-err"></span>
        <span>Please fix the highlighted fields: ${Object.values(errors).join('; ')}</span>
      </div>`;
    return;
  }

  btn.disabled = true;
  showScanning(FIXTURE_ANNOUNCEMENTS.length);

  const t0 = performance.now();
  try {
    const matches = await scanAnnouncements(
      FIXTURE_ANNOUNCEMENTS,
      viewingKey,
      spendingPubKey,
      spendingScalar,
    );
    const elapsed = Math.round(performance.now() - t0);
    renderResults(matches, FIXTURE_ANNOUNCEMENTS.length, elapsed);
  } catch (err) {
    console.error('Scan error:', err);
    renderResults(null, 0, 0);
  } finally {
    btn.disabled = false;
  }
});

// ── Load demo keys ───────────────────────────────────────────
document.getElementById('loadFixture').addEventListener('click', () => {
  document.getElementById('metaAddr').value        = DEMO_META_ADDRESS;
  document.getElementById('viewingKey').value      = DEMO_VIEWING_KEY_HEX;
  document.getElementById('spendingScalar').value  = DEMO_SPENDING_SCALAR.toString();
  ['metaAddr','viewingKey','spendingScalar'].forEach(id => {
    document.getElementById(id).classList.remove('error');
  });
  document.getElementById('results').innerHTML = '';
});

// ── Boot ─────────────────────────────────────────────────────
renderFixtureTable();
