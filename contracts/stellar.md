# Stellar Contracts

Soroban smart contracts (Rust) for stealth address operations on the Stellar network.

## Contract Set

| Contract | Purpose |
|---|---|
| stealth-announcer | Emits stealth address announcements |
| stealth-registry | Maps addresses to stealth meta-addresses |
| stealth-sender | Atomic send + announce |
| wraith-names | `.wraith` name to meta-address mapping |

---

## stealth-announcer

Emits announcement events. No persistent storage.

### Interface

```rust
pub fn announce(
    env: Env,
    caller: Address,
    scheme_id: u32,
    stealth_address: Address,
    ephemeral_pub_key: BytesN<32>,
    metadata: Bytes,
);
```

### Event

Emits a contract event with topic `"announce"`:

```rust
// Event: ("announce", caller, scheme_id, stealth_address, ephemeral_pub_key, metadata)
```

### Usage

```typescript
import { SCHEME_ID, bytesToHex } from "@wraith-protocol/sdk/chains/stellar";

// After generating a stealth address
const tx = new TransactionBuilder(account, { fee: "100" })
  .addOperation(contract.call(
    "announce",
    xdr.ScVal.scvAddress(callerAddress),
    xdr.ScVal.scvU32(SCHEME_ID),
    xdr.ScVal.scvAddress(stealthAddress),
    xdr.ScVal.scvBytes(ephemeralPubKey),
    xdr.ScVal.scvBytes(metadata),
  ))
  .build();
```

---

## stealth-registry

Maps addresses to 64-byte stealth meta-addresses.

### Interface

```rust
pub fn register_keys(
    env: Env,
    registrant: Address,
    scheme_id: u32,
    stealth_meta_address: Bytes,
);

pub fn stealth_meta_address_of(
    env: Env,
    registrant: Address,
    scheme_id: u32,
) -> Bytes;
```

### Validation

- Enforces 64-byte meta-address length (32 bytes spend + 32 bytes view)
- Requires auth from `registrant`

### Usage

```typescript
import { encodeStealthMetaAddress } from "@wraith-protocol/sdk/chains/stellar";

const metaAddress = encodeStealthMetaAddress(keys.spendingPubKey, keys.viewingPubKey);
// Register the raw 64-byte key material (without the "st:xlm:" prefix)
```

---

## stealth-sender

Atomic send + announce. Initializes with the announcer contract address.

### Interface

```rust
pub fn init(env: Env, admin: Address, announcer: Address);

pub fn send(
    env: Env,
    caller: Address,
    token: Address,
    stealth_address: Address,
    amount: i128,
    scheme_id: u32,
    ephemeral_pub_key: BytesN<32>,
    metadata: Bytes,
);

pub fn batch_send(
    env: Env,
    caller: Address,
    token: Address,
    stealth_addresses: Vec<Address>,
    amounts: Vec<i128>,
    scheme_id: u32,
    ephemeral_pub_keys: Vec<BytesN<32>>,
    metadatas: Vec<Bytes>,
);
```

The `send` function:
1. Transfers `amount` of `token` from `caller` to `stealth_address`
2. Calls the announcer contract to emit an event

### Usage

```typescript
import { generateStealthAddress, SCHEME_ID } from "@wraith-protocol/sdk/chains/stellar";

const stealth = generateStealthAddress(spendingPubKey, viewingPubKey);

// Send XLM + announce in one tx
const tx = new TransactionBuilder(account, { fee: "100" })
  .addOperation(senderContract.call(
    "send",
    callerAddress,
    xlmTokenAddress,
    stealth.stealthAddress,
    amount,
    SCHEME_ID,
    stealth.ephemeralPubKey,
    viewTagMetadata,
  ))
  .build();
```

---

## wraith-names

Name to meta-address mapping. Names are hashed via SHA-256 for storage keys.

### Interface

```rust
pub fn register(env: Env, caller: Address, name: String, meta_address: Bytes);
pub fn update(env: Env, caller: Address, name: String, new_meta_address: Bytes);
pub fn release(env: Env, caller: Address, name: String);
pub fn resolve(env: Env, name: String) -> Bytes;
pub fn name_of(env: Env, meta_address: Bytes) -> String;
```

### Validation

- Name: 3-32 characters, lowercase alphanumeric only
- Meta-address: must be exactly 64 bytes
- Caller auth required for register, update, release

### Usage

```typescript
import { encodeStealthMetaAddress } from "@wraith-protocol/sdk/chains/stellar";

const metaAddress = encodeStealthMetaAddress(keys.spendingPubKey, keys.viewingPubKey);

// Register
const tx = new TransactionBuilder(account, { fee: "100" })
  .addOperation(namesContract.call("register", callerAddress, "alice", metaBytes))
  .build();

// Resolve
const resolved = await namesContract.call("resolve", "alice");
```

---

## Deployment

### Build

```bash
cd contracts/stealth-announcer && soroban contract build
cd contracts/stealth-registry && soroban contract build
cd contracts/stealth-sender && soroban contract build
cd contracts/wraith-names && soroban contract build
```

### Deploy

```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/stealth_announcer.wasm \
  --network testnet \
  --source <deployer-key>
```

### Initialize stealth-sender

After deploying both the announcer and sender:

```bash
soroban contract invoke \
  --id <sender-contract-id> \
  --network testnet \
  --source <admin-key> \
  -- init \
  --admin <admin-address> \
  --announcer <announcer-contract-id>
```

### Event Fetching

Stellar announcements are fetched via Soroban RPC, not a subgraph:

```typescript
const events = await sorobanServer.getEvents({
  startLedger: lastProcessedLedger,
  filters: [{
    type: "contract",
    contractIds: [announcerContractId],
    topics: [["announce"]],
  }],
});
```

---

## Differences from EVM Contracts

| Aspect | EVM (Solidity) | Stellar (Soroban) |
|---|---|---|
| Language | Solidity | Rust |
| Name sig verification | On-chain ECDSA recovery | Caller auth (Soroban built-in) |
| Event indexing | Subgraph / The Graph | Soroban RPC `getEvents` |
| Account model | Address always exists | Must `createAccount` first |
| Token transfers | `msg.value` / `safeTransferFrom` | Soroban token contract calls |
| Gas sponsorship | EIP-7702 (WraithWithdrawer) | Not applicable |
