// generate-fixtures.mjs
// Run: node scripts/playground/generate-fixtures.mjs
// Outputs hardcoded fixture values for scanner.js
//
// Uses the same algorithms as the Wraith SDK (inline, no SDK import)
// so the docs repo doesn't need the SDK installed at build time.

import { createHash } from 'node:crypto';

// ── Curve25519 field arithmetic ──────────────────────────────
const P  = (2n ** 255n) - 19n;
const A24 = 121665n;
const L  = (2n ** 252n) + 27742317777372353535851937790883648493n;

const fmod = x => { let r = x % P; return r < 0n ? r + P : r; };
const fadd = (a,b) => fmod(a+b);
const fsub = (a,b) => fmod(a-b);
const fmul = (a,b) => fmod(a*b);
function fpow(base, exp) {
  base = fmod(base); let r = 1n;
  while (exp > 0n) { if (exp&1n) r=fmul(r,base); base=fmul(base,base); exp>>=1n; }
  return r;
}
const finv = a => fpow(a, P-2n);

// ── helpers ──────────────────────────────────────────────────
function bytesToBigintLE(b) {
  let n=0n; for (let i=b.length-1;i>=0;i--) n=(n<<8n)|BigInt(b[i]); return n;
}
function bigintToBytesLE(n, len) {
  const o=Buffer.alloc(len); for(let i=0;i<len;i++){o[i]=Number(n&0xffn);n>>=8n;} return o;
}
function hexToBytes(h) { return Buffer.from(h,'hex'); }
function bytesToHex(b) { return Buffer.from(b).toString('hex'); }
function concatBufs(...a) { return Buffer.concat(a.map(x=>Buffer.from(x))); }
function sha256(...parts) { return createHash('sha256').update(concatBufs(...parts)).digest(); }
function sha512(d) { return createHash('sha512').update(d).digest(); }

// ── ed25519 math ─────────────────────────────────────────────
const ED_D  = fmod(-121665n * finv(121666n));
const ED_GY = fmod(4n * finv(5n));
const ED_GX = (() => {
  const y2=fmul(ED_GY,ED_GY), num=fsub(y2,1n), den=fadd(fmul(ED_D,y2),1n);
  const x2=fmul(num,finv(den));
  let x=fpow(x2,(P+3n)/8n);
  if (fmul(x,x)!==x2) x=fmul(x,fpow(2n,(P-1n)/4n));
  if (x%2n!==0n) x=P-x; return x;
})();
const ED_G = [ED_GX, ED_GY, 1n, fmul(ED_GX,ED_GY)];

function edAdd(P1,P2){
  const[X1,Y1,Z1,T1]=P1,[X2,Y2,Z2,T2]=P2;
  const A=fmul(fsub(Y1,X1),fsub(Y2,X2)),B=fmul(fadd(Y1,X1),fadd(Y2,X2));
  const C=fmul(fmul(2n,ED_D),fmul(T1,T2)),D=fmul(2n,fmul(Z1,Z2));
  const E=fsub(B,A),F=fsub(D,C),G=fadd(D,C),H=fadd(B,A);
  return[fmul(E,F),fmul(G,H),fmul(F,G),fmul(E,H)];
}
function edMul(k,pt){
  let Q=[0n,1n,1n,0n],R=pt;
  while(k>0n){if(k&1n)Q=edAdd(Q,R);R=edAdd(R,R);k>>=1n;} return Q;
}
function edCompress(pt){
  const[X,Y,Z]=pt,zi=finv(Z),x=fmul(X,zi),y=fmul(Y,zi);
  const o=bigintToBytesLE(y,32); if(x&1n)o[31]|=0x80; return o;
}
function edDecompress(b){
  const c=Buffer.from(b); const sign=(c[31]>>7)&1; c[31]&=0x7f;
  const y=bytesToBigintLE(c),y2=fmul(y,y),num=fsub(y2,1n),den=fadd(fmul(ED_D,y2),1n);
  const x2=fmul(num,finv(den)); let x=fpow(x2,(P+3n)/8n);
  if(fmul(x,x)!==fmod(x2))x=fmul(x,fpow(2n,(P-1n)/4n));
  if(Number(x&1n)!==sign)x=P-x; return[x,y,1n,fmul(x,y)];
}

// seedToScalar: expand 32-byte seed via SHA-512 lower half, clamp
function seedToScalar(seed) {
  const h = sha512(seed); const a=h.slice(0,32);
  a[0]&=248; a[31]&=127; a[31]|=64; return bytesToBigintLE(a);
}
function seedToPubKey(seed) { return edCompress(edMul(seedToScalar(seed),ED_G)); }

// ── X25519 ───────────────────────────────────────────────────
function clamp(s){ let c=s&((1n<<255n)-1n); c&=~7n; c|=(1n<<254n); return c; }
function x25519(scalar,u){
  const s=clamp(scalar);
  let x1=u,x2=1n,z2=0n,x3=u,z3=1n,sw=0n;
  for(let t=254n;t>=0n;t--){
    const bit=(s>>t)&1n,xs=sw^bit; sw=bit;
    if(xs===1n){[x2,x3]=[x3,x2];[z2,z3]=[z3,z2];}
    const A=fadd(x2,z2),AA=fmul(A,A),B=fsub(x2,z2),BB=fmul(B,B),E=fsub(AA,BB);
    const C=fadd(x3,z3),D=fsub(x3,z3),DA=fmul(D,A),CB=fmul(C,B);
    x3=fpow(fadd(DA,CB),2n); z3=fmul(x1,fpow(fsub(DA,CB),2n));
    x2=fmul(AA,BB); z2=fmul(E,fadd(AA,fmul(A24,E)));
  }
  if(sw===1n){[x2,x3]=[x3,x2];}
  return fmul(x2,finv(z2));
}
function edPubToMont(b){
  const c=Buffer.from(b); c[31]&=0x7f;
  const y=bytesToBigintLE(c),u=fmul(fadd(1n,y),finv(fsub(1n,y)));
  return bigintToBytesLE(u,32);
}
function edSeedToMontScalar(seed){
  const h=sha512(seed),a=h.slice(0,32); a[0]&=248;a[31]&=127;a[31]|=64; return a;
}
function sharedSecret(viewingSeed, ephPub){
  const priv=bytesToBigintLE(edSeedToMontScalar(viewingSeed));
  const pubU=bytesToBigintLE(edPubToMont(ephPub));
  return bigintToBytesLE(x25519(priv,pubU),32);
}

// ── Stellar StrKey ───────────────────────────────────────────
function crc16(data){
  let c=0xffff; for(const b of data){c^=(b<<8);for(let i=0;i<8;i++)c=(c&0x8000)?((c<<1)^0x1021):(c<<1);c&=0xffff;} return c;
}
const B32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(bytes){
  let bits=0,val=0,o='';
  for(const b of bytes){val=(val<<8)|b;bits+=8;while(bits>=5){bits-=5;o+=B32[(val>>bits)&31];}}
  if(bits>0)o+=B32[(val<<(5-bits))&31]; return o;
}
function pubToAddr(pub){
  const p=Buffer.alloc(33); p[0]=0x30; pub.copy(p,1);
  const c=crc16(p),f=Buffer.alloc(35); p.copy(f); f[33]=c&0xff;f[34]=(c>>8)&0xff;
  return b32enc(f);
}

// ── Fixture generation ───────────────────────────────────────
// Deterministic "demo" recipient keys
const viewingSeed    = sha256(Buffer.from('wraith:viewing:demo'));
const spendingSeed   = sha256(Buffer.from('wraith:spending:demo'));
const viewingPub     = seedToPubKey(viewingSeed);
const spendingPub    = seedToPubKey(spendingSeed);
const spendingScalar = seedToScalar(spendingSeed);

console.log('=== DEMO KEYS ===');
console.log('viewingKey (hex seed):  ', bytesToHex(viewingSeed));
console.log('spendingScalar (bigint):', spendingScalar.toString());
console.log('spendingPubKey (hex):   ', bytesToHex(spendingPub));
console.log('viewingPubKey (hex):    ', bytesToHex(viewingPub));
console.log('metaAddress:            ', `st:xlm:${bytesToHex(spendingPub)}${bytesToHex(viewingPub)}`);
console.log('');

// Generate 5 fixture announcements; indices 0 and 2 are "yours"
const YOURS_INDICES = new Set([0,2]);

function makeAnnouncement(ephSeed, isYours) {
  // ephemeral keypair
  const ephPrivScalar = seedToScalar(ephSeed);
  const ephPub = edCompress(edMul(ephPrivScalar, ED_G));

  if (!isYours) {
    // noise: random stealth address, wrong view tag
    const noiseKey = sha256(ephSeed, Buffer.from('noise'));
    const noisePub = edCompress(edMul(seedToScalar(noiseKey), ED_G));
    const noiseAddr = pubToAddr(Buffer.from(noisePub));
    const noiseTag = sha256(Buffer.from('wraith:tag:'), noiseKey)[0];
    const meta = Buffer.alloc(32); meta[0] = noiseTag;
    return {
      schemeId: 1,
      stealthAddress: noiseAddr,
      caller: pubToAddr(Buffer.from(ephPub)),
      ephemeralPubKey: bytesToHex(ephPub),
      metadata: bytesToHex(meta),
      _yours: false,
    };
  }

  // Compute shared secret from ephemeral privkey and recipient viewing pub
  const ephPriv = bytesToBigintLE(edSeedToMontScalar(ephSeed));
  const viewingMontPub = bytesToBigintLE(edPubToMont(viewingPub));
  const sharedU = x25519(ephPriv, viewingMontPub);
  const shared = bigintToBytesLE(sharedU, 32);

  // view tag
  const viewTag = sha256(Buffer.from('wraith:tag:'), shared)[0];
  // hash scalar
  const hScalarBytes = sha256(Buffer.from('wraith:scalar:'), shared);
  const hScalar = bytesToBigintLE(hScalarBytes) % L;
  // stealth pub = spendingPub + hScalar * G
  const spendPt = edDecompress(spendingPub);
  const hG = edMul(hScalar, ED_G);
  const stealthPt = edAdd(spendPt, hG);
  const stealthPub = edCompress(stealthPt);
  const stealthAddr = pubToAddr(Buffer.from(stealthPub));
  // metadata: first byte = view tag
  const meta = Buffer.alloc(32); meta[0] = viewTag;

  console.log(`[Match] ephSeed=${bytesToHex(ephSeed).slice(0,16)}…`);
  console.log(`  ephPub:      ${bytesToHex(ephPub)}`);
  console.log(`  viewTag:     0x${viewTag.toString(16).padStart(2,'0')}`);
  console.log(`  stealthAddr: ${stealthAddr}`);
  console.log(`  metadata:    ${bytesToHex(meta)}`);

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
  sha256(Buffer.from('eph:0')),
  sha256(Buffer.from('eph:1')),
  sha256(Buffer.from('eph:2')),
  sha256(Buffer.from('eph:3')),
  sha256(Buffer.from('eph:4')),
];

const fixtures = seeds.map((s,i) => makeAnnouncement(s, YOURS_INDICES.has(i)));

console.log('\n=== FIXTURE_ANNOUNCEMENTS (paste into scanner.js) ===');
console.log(JSON.stringify(fixtures, (k,v) => typeof v==='bigint'?v.toString():v, 2));
