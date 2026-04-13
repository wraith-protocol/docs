# EVM Crypto Primitives

Low-level stealth address functions for EVM-compatible chains (Horizen, Ethereum, Polygon, Base, etc.) using secp256k1. Import from `@wraith-protocol/sdk/chains/evm`.

Most developers should use the [Agent Client](../agent-client.md) instead. These primitives are for power users building custom stealth address integrations.

## Installation

```bash
npm install @wraith-protocol/sdk
```

## Import

```typescript
import {
  deriveStealthKeys,
  generateStealthAddress,
  checkStealthAddress,
  scanAnnouncements,
  deriveStealthPrivateKey,
  encodeStealthMetaAddress,
  decodeStealthMetaAddress,
  signNameRegistration,
  signNameRegistrationOnBehalf,
  signNameUpdate,
  signNameRelease,
  metaAddressToBytes,
  STEALTH_SIGNING_MESSAGE,
  SCHEME_ID,
  META_ADDRESS_PREFIX,
} from "@wraith-protocol/sdk/chains/evm";
```

## Types

```typescript
type HexString = `0x${string}`;

interface StealthKeys {
  spendingKey: HexString;      // 32-byte private key
  viewingKey: HexString;       // 32-byte private key
  spendingPubKey: HexString;   // 33-byte compressed public key
  viewingPubKey: HexString;    // 33-byte compressed public key
}

interface GeneratedStealthAddress {
  stealthAddress: HexString;   // 20-byte EVM address
  ephemeralPubKey: HexString;  // 33-byte compressed public key
  viewTag: number;             // 0-255
}

interface Announcement {
  schemeId: bigint;
  stealthAddress: HexString;
  caller: HexString;
  ephemeralPubKey: HexString;
  metadata: HexString;         // first byte is view tag
}

interface MatchedAnnouncement extends Announcement {
  stealthPrivateKey: HexString;
}
```

## Constants

```typescript
STEALTH_SIGNING_MESSAGE = "Sign this message to generate your Wraith stealth keys.\n\nChain: Horizen\nNote: This signature is used for key derivation only and does not authorize any transaction."
SCHEME_ID = 1n  // bigint for on-chain compatibility
META_ADDRESS_PREFIX = "st:eth:0x"
```

---

## Functions

### `deriveStealthKeys(signature)`

Derive spending and viewing key pairs from a wallet signature.

```typescript
const signature = await wallet.signMessage(STEALTH_SIGNING_MESSAGE);
const keys = deriveStealthKeys(signature as HexString);

console.log(keys.spendingKey);    // "0x..." (32-byte private key)
console.log(keys.viewingKey);     // "0x..." (32-byte private key)
console.log(keys.spendingPubKey); // "0x02..." (33-byte compressed)
console.log(keys.viewingPubKey);  // "0x03..." (33-byte compressed)
```

**Algorithm:**
1. Split the 65-byte signature: `r = sig[0:32]`, `s = sig[32:64]`
2. `spendingKey = keccak256(r)`
3. `viewingKey = keccak256(s)`
4. Derive compressed public keys from each private key

Same signature always produces the same keys. The spending key is never equal to the viewing key.

### `generateStealthAddress(spendingPubKey, viewingPubKey, ephemeralKey?)`

Generate a one-time stealth address for a recipient.

```typescript
const result = generateStealthAddress(
  keys.spendingPubKey,
  keys.viewingPubKey
);

console.log(result.stealthAddress);  // "0x..." (fresh one-time address)
console.log(result.ephemeralPubKey); // "0x..." (publish with announcement)
console.log(result.viewTag);        // 0-255 (publish with announcement)
```

**Algorithm:**
1. Generate random ephemeral key pair `(r, R = r * G)`
2. Compute ECDH shared secret `S = r * viewingPubKey`
3. `hashedSecret = keccak256(S)`
4. `viewTag = hashedSecret[0]`
5. `stealthPoint = spendingPubKey + hash(S) * G`
6. `stealthAddress = keccak256(stealthPoint)[12:32]`

Each call produces a different address (new ephemeral key). Pass an explicit `ephemeralKey` for deterministic testing.

### `checkStealthAddress(ephemeralPubKey, viewingKey, spendingPubKey, viewTag)`

Check if a stealth address announcement belongs to you.

```typescript
const result = checkStealthAddress(
  announcement.ephemeralPubKey,
  keys.viewingKey,
  keys.spendingPubKey,
  viewTag
);

if (result.isMatch) {
  console.log(result.stealthAddress); // the address that matched
}
```

Uses view tag for fast rejection — eliminates ~255/256 non-matching announcements without computing the full stealth address.

### `scanAnnouncements(announcements, viewingKey, spendingPubKey, spendingKey)`

Scan an array of on-chain announcements and return the ones that belong to you.

```typescript
const announcements: Announcement[] = [
  // from subgraph query or chain events
];

const matched = scanAnnouncements(
  announcements,
  keys.viewingKey,
  keys.spendingPubKey,
  keys.spendingKey
);

for (const m of matched) {
  console.log(m.stealthAddress);    // address you control
  console.log(m.stealthPrivateKey); // private key for this address
}
```

For each announcement:
1. Skip if `schemeId` doesn't match
2. Extract view tag from metadata
3. Check if it matches using `checkStealthAddress`
4. If matched, derive the stealth private key

### `deriveStealthPrivateKey(spendingKey, ephemeralPubKey, viewingKey)`

Compute the private key that controls a specific stealth address.

```typescript
const privateKey = deriveStealthPrivateKey(
  keys.spendingKey,
  stealth.ephemeralPubKey,
  keys.viewingKey
);

// Use this key to sign transactions from the stealth address
import { privateKeyToAccount } from "viem/accounts";
const account = privateKeyToAccount(privateKey);
console.log(account.address); // matches the stealth address
```

**Algorithm:**
1. `S = viewingKey * ephemeralPubKey` (shared secret)
2. `hashScalar = keccak256(S) mod n`
3. `stealthPrivateKey = (spendingKey + hashScalar) mod n`

### `encodeStealthMetaAddress(spendingPubKey, viewingPubKey)`

Encode two public keys into a stealth meta-address string.

```typescript
const metaAddress = encodeStealthMetaAddress(
  keys.spendingPubKey,
  keys.viewingPubKey
);
// "st:eth:0x02abc...03def..."
```

Both keys must be 33-byte compressed secp256k1 points.

### `decodeStealthMetaAddress(metaAddress)`

Decode a meta-address back into its component public keys.

```typescript
const { spendingPubKey, viewingPubKey } = decodeStealthMetaAddress(
  "st:eth:0x02abc...03def..."
);
```

Validates the prefix, length, and that both keys are valid curve points.

### `metaAddressToBytes(metaAddress)`

Strip the `st:eth:` prefix from a meta-address, returning the raw hex bytes.

```typescript
const bytes = metaAddressToBytes("st:eth:0x02abc...03def...");
// "0x02abc...03def..."
```

### `signNameRegistration(name, metaAddressBytes, spendingKey)`

Sign a message for on-chain `.wraith` name registration.

```typescript
const metaBytes = metaAddressToBytes(metaAddress);
const sig = signNameRegistration("alice", metaBytes, keys.spendingKey);
// 65-byte hex signature for the WraithNames contract
```

### `signNameRegistrationOnBehalf(name, metaAddressBytes, spendingKey, nonce)`

Sign with a nonce for delegated registration.

```typescript
const sig = signNameRegistrationOnBehalf("alice", metaBytes, keys.spendingKey, 0n);
```

### `signNameUpdate(name, newMetaAddressBytes, spendingKey)`

Sign a name update to point to a new meta-address.

```typescript
const sig = signNameUpdate("alice", newMetaBytes, keys.spendingKey);
```

### `signNameRelease(name, spendingKey)`

Sign a name release to give up ownership.

```typescript
const sig = signNameRelease("alice", keys.spendingKey);
```

---

## End-to-End Flow

```typescript
import {
  deriveStealthKeys,
  generateStealthAddress,
  scanAnnouncements,
  deriveStealthPrivateKey,
  encodeStealthMetaAddress,
  decodeStealthMetaAddress,
  STEALTH_SIGNING_MESSAGE,
  SCHEME_ID,
} from "@wraith-protocol/sdk/chains/evm";
import type { HexString, Announcement } from "@wraith-protocol/sdk/chains/evm";

// 1. Recipient: derive keys from wallet signature
const sig = await wallet.signMessage(STEALTH_SIGNING_MESSAGE);
const keys = deriveStealthKeys(sig as HexString);

// 2. Recipient: publish stealth meta-address
const metaAddress = encodeStealthMetaAddress(keys.spendingPubKey, keys.viewingPubKey);
// Share "st:eth:0x..." or register as a .wraith name

// 3. Sender: generate stealth address from meta-address
const { spendingPubKey, viewingPubKey } = decodeStealthMetaAddress(metaAddress);
const stealth = generateStealthAddress(spendingPubKey, viewingPubKey);

// 4. Sender: send ETH to stealth.stealthAddress
//    Sender: call announcer contract with (stealth.ephemeralPubKey, stealth.viewTag)

// 5. Recipient: scan announcements
const announcements: Announcement[] = [/* from subgraph or chain events */];
const matched = scanAnnouncements(
  announcements,
  keys.viewingKey,
  keys.spendingPubKey,
  keys.spendingKey
);

// 6. Recipient: spend from stealth address
for (const m of matched) {
  const account = privateKeyToAccount(m.stealthPrivateKey);
  // Sign and submit transactions from account.address
}
```
