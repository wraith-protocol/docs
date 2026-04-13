# SDK Overview

`@wraith-protocol/sdk` is a single npm package with multiple entry points. Most developers use the root import. Power users building custom stealth address integrations use the chain-specific imports.

## Installation

```bash
npm install @wraith-protocol/sdk
```

## Entry Points

| Import | Purpose | Audience |
|---|---|---|
| `@wraith-protocol/sdk` | Agent client — create agents, chat, payments | Most developers |
| `@wraith-protocol/sdk/chains/evm` | Raw secp256k1 stealth crypto primitives | Power users building custom EVM integrations |
| `@wraith-protocol/sdk/chains/stellar` | Raw ed25519 stealth crypto for Stellar | Power users building on Stellar |

### Root Import — Agent Client

```typescript
import { Wraith, Chain } from "@wraith-protocol/sdk";
```

This is the managed platform client. It talks to Wraith's hosted TEE infrastructure over HTTP. Zero heavy dependencies — just `fetch` and TypeScript types. No crypto libraries, no database drivers, no native modules.

### Chain Imports — Crypto Primitives

```typescript
// EVM chains (secp256k1)
import {
  generateStealthAddress,
  deriveStealthKeys,
  scanAnnouncements,
  deriveStealthPrivateKey,
} from "@wraith-protocol/sdk/chains/evm";

// Stellar (ed25519)
import {
  generateStealthAddress,
  deriveStealthKeys,
  scanAnnouncements,
  deriveStealthPrivateScalar,
} from "@wraith-protocol/sdk/chains/stellar";
```

Each chain module exports the same conceptual functions adapted to that chain's cryptographic scheme and address format. You only need these if you're building custom stealth address integrations without the managed agent platform.

## The `Chain` Enum

Always use the `Chain` enum when specifying chains. Never pass raw strings.

```typescript
import { Chain } from "@wraith-protocol/sdk";

// Single chain
const agent = await wraith.createAgent({
  name: "alice",
  chain: Chain.Horizen,
  wallet: "0x...",
  signature: "0x...",
});

// Multiple chains
const agent = await wraith.createAgent({
  name: "bob",
  chain: [Chain.Horizen, Chain.Stellar, Chain.Ethereum],
  wallet: "0x...",
  signature: "0x...",
});

// All supported chains
const agent = await wraith.createAgent({
  name: "carol",
  chain: Chain.All,
  wallet: "0x...",
  signature: "0x...",
});
```

### Available Values

```typescript
enum Chain {
  Horizen = "horizen",
  Ethereum = "ethereum",
  Polygon = "polygon",
  Base = "base",
  Stellar = "stellar",
  Solana = "solana",
  All = "all",
}
```

## Dependencies

| Package | Used By | Purpose |
|---|---|---|
| `@noble/curves` | EVM + Stellar chains | Elliptic curve operations |
| `@noble/hashes` | EVM + Stellar chains | SHA-256, SHA-512, keccak256 |
| `viem` | EVM chains + agent client | EVM utilities, address encoding |
| `@stellar/stellar-sdk` | Stellar chain (optional peer dep) | StrKey encoding for Stellar addresses |

`@stellar/stellar-sdk` is an optional peer dependency. It's only needed if you import `@wraith-protocol/sdk/chains/stellar`.

## Package Exports

The SDK uses `package.json` exports to expose multiple entry points from a single package:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./chains/evm": {
      "types": "./dist/chains/evm/index.d.ts",
      "import": "./dist/chains/evm/index.js",
      "require": "./dist/chains/evm/index.cjs"
    },
    "./chains/stellar": {
      "types": "./dist/chains/stellar/index.d.ts",
      "import": "./dist/chains/stellar/index.js",
      "require": "./dist/chains/stellar/index.cjs"
    }
  }
}
```

Both ESM and CJS formats are supported. TypeScript declarations are included.

## Next Steps

- [Agent Client API](agent-client.md) — full reference for `Wraith` and `WraithAgent` classes
- [EVM Crypto Primitives](chains/evm.md) — low-level stealth address functions for EVM
- [Stellar Crypto Primitives](chains/stellar.md) — low-level stealth address functions for Stellar
