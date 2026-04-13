# EVM Contracts

Solidity smart contracts for stealth address operations on EVM-compatible chains. Four contracts are deployed per chain.

## Contract Set

| Contract | Purpose |
|---|---|
| ERC5564Announcer | Emits stealth address announcements |
| ERC6538Registry | Maps addresses to stealth meta-addresses |
| WraithSender | Atomic send + announce in one transaction |
| WraithNames | `.wraith` name to meta-address mapping |
| WraithWithdrawer | Gas-sponsored withdrawals (EIP-7702) |

---

## ERC5564Announcer

Minimal singleton. No storage, no access control. Just emits events.

### Event

```solidity
event Announcement(
    uint256 indexed schemeId,
    address indexed stealthAddress,
    address indexed caller,
    bytes ephemeralPubKey,
    bytes metadata  // first byte = view tag
);
```

### Function

```solidity
function announce(
    uint256 schemeId,
    address stealthAddress,
    bytes memory ephemeralPubKey,
    bytes memory metadata
) external;
```

**Deployment:** One per chain. No constructor args. No proxy needed.

### Usage

```typescript
import { SCHEME_ID } from "@wraith-protocol/sdk/chains/evm";

// After generating a stealth address, announce it
await announcer.write.announce([
  SCHEME_ID,
  stealthAddress,
  ephemeralPubKey,
  metadata, // view tag as first byte
]);
```

---

## ERC6538Registry

Maps addresses to stealth meta-addresses per ERC-6538. Supports direct and delegated registration via EIP-712 signatures.

### Functions

```solidity
// Direct registration
function registerKeys(uint256 schemeId, bytes calldata stealthMetaAddress) external;

// Delegated registration via signature
function registerKeysOnBehalf(
    address registrant,
    uint256 schemeId,
    bytes calldata stealthMetaAddress,
    bytes calldata signature
) external;

// Lookup
function stealthMetaAddressOf(
    address registrant,
    uint256 schemeId
) external view returns (bytes memory);

// Replay prevention
function incrementNonce(address registrant) external;
function nonceOf(address registrant) external view returns (uint256);
```

### Usage

```typescript
import { SCHEME_ID, metaAddressToBytes } from "@wraith-protocol/sdk/chains/evm";

// Register meta-address
const metaBytes = metaAddressToBytes(metaAddress);
await registry.write.registerKeys([SCHEME_ID, metaBytes]);

// Look up
const stored = await registry.read.stealthMetaAddressOf([address, SCHEME_ID]);
```

---

## WraithSender

Atomically transfers assets to stealth addresses and publishes announcements. Uses `ReentrancyGuard`.

### Functions

```solidity
// Send native ETH
function sendETH(
    uint256 schemeId,
    address stealthAddress,
    bytes memory ephemeralPubKey,
    bytes memory metadata
) external payable;

// Send ERC-20 tokens
function sendERC20(
    uint256 schemeId,
    address stealthAddress,
    bytes memory ephemeralPubKey,
    bytes memory metadata,
    address token,
    uint256 amount,
    uint256 gasTip  // optional ETH tip for gas at stealth address
) external payable;

// Batch send native ETH
function batchSendETH(
    uint256 schemeId,
    address[] calldata stealthAddresses,
    bytes[] calldata ephemeralPubKeys,
    bytes[] calldata metadatas,
    uint256[] calldata amounts
) external payable;
```

**Constructor:** Takes announcer contract address.

### Usage

```typescript
import { generateStealthAddress, SCHEME_ID } from "@wraith-protocol/sdk/chains/evm";

const stealth = generateStealthAddress(spendingPubKey, viewingPubKey);
const metadata = `0x${stealth.viewTag.toString(16).padStart(2, "0")}`;

// Send ETH + announce in one tx
await sender.write.sendETH(
  [SCHEME_ID, stealth.stealthAddress, stealth.ephemeralPubKey, metadata],
  { value: parseEther("0.1") }
);
```

---

## WraithNames

Privacy-preserving name registry. Maps human-readable names to stealth meta-addresses. Ownership proven via secp256k1 signature from the spending key embedded in the meta-address.

### Functions

```solidity
function register(
    string calldata name,
    bytes calldata metaAddress,
    bytes calldata signature
) external;

function registerOnBehalf(
    string calldata name,
    bytes calldata metaAddress,
    bytes calldata signature
) external;

function update(
    string calldata name,
    bytes calldata newMetaAddress,
    bytes calldata signature
) external;

function release(
    string calldata name,
    bytes calldata signature
) external;

function resolve(string calldata name) external view returns (bytes memory);
function nameOf(bytes calldata metaAddress) external view returns (string memory);
```

### Name Rules

- 3-32 characters
- Lowercase alphanumeric and hyphens only
- No leading or trailing hyphens

### Signature Verification

The contract decompresses the spending public key from the first 33 bytes of the meta-address and verifies an ECDSA signature over `keccak256(name || metaAddress)` with Ethereum signed message prefix. Includes on-chain point decompression (`y = sqrt(x^3 + 7) mod p`).

### Usage

```typescript
import {
  signNameRegistration,
  metaAddressToBytes,
} from "@wraith-protocol/sdk/chains/evm";

const metaBytes = metaAddressToBytes(metaAddress);
const sig = signNameRegistration("alice", metaBytes, keys.spendingKey);

await names.write.register(["alice", metaBytes, sig]);

// Resolve
const resolved = await names.read.resolve(["alice"]);

// Reverse lookup
const name = await names.read.nameOf([metaBytes]);
```

---

## WraithWithdrawer

EIP-7702 delegation target for gas-sponsored stealth address withdrawals. A sponsor pays gas on behalf of the stealth address.

### Functions

```solidity
// Sponsored withdrawals (sponsor pays gas)
function withdrawETH(address payable to, uint256 sponsorFee) external;
function withdrawERC20(address token, address to, uint256 sponsorFee) external;

// Direct withdrawals (stealth address pays own gas)
function withdrawETHDirect(address payable to) external;
function withdrawERC20Direct(address token, address to) external;
```

---

## Deployment

### Deploy Script

```bash
npx hardhat run scripts/deploy.ts --network <chain>
```

### Deployment Order

1. Deploy ERC5564Announcer (no constructor args)
2. Deploy ERC6538Registry (no constructor args)
3. Deploy WraithSender (arg: announcer address)
4. Deploy WraithNames (no constructor args)
5. Deploy WraithWithdrawer (no constructor args) — optional, if EIP-7702 supported

### Indexing

Set up a subgraph to index `Announcement` events from the announcer contract:

```graphql
type Announcement @entity {
  id: ID!
  schemeId: BigInt!
  stealthAddress: Bytes!
  caller: Bytes!
  ephemeralPubKey: Bytes!
  metadata: Bytes!
  blockNumber: BigInt!
  transactionHash: Bytes!
}
```

### Deployed Addresses (Horizen Testnet)

| Contract | Address |
|---|---|
| ERC5564Announcer | `0x8AE65c05E7eb48B9bA652781Bc0a3DBA09A484F3` |
| ERC6538Registry | `0x953E6cEdcdfAe321796e7637d33653F6Ce05c527` |
| WraithSender | `0x226C5eb4e139D9fa01cc09eA318638b090b12095` |
| WraithNames | `0x3d46f709a99A3910f52bD292211Eb5D557F882D6` |
