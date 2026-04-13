# Wraith Protocol

Wraith is a multichain stealth address platform. Send and receive private payments across EVM chains and Stellar through a single SDK. An AI agent handles chain-specific crypto, key management, and privacy analysis inside Trusted Execution Environment hardware.

## How It Works

```
Your App
    |
    v
@wraith-protocol/sdk              <-- npm package
    |
    v
Wraith TEE Infrastructure         <-- managed by Wraith (Phala TEE)
    |
    v
Blockchains                       <-- Horizen, Stellar, Ethereum, ...
```

You install the SDK, get an API key, and build. No servers to run. No keys to manage. No chain-specific crypto to implement.

## Quick Start

### 1. Install

```bash
npm install @wraith-protocol/sdk
```

### 2. Create an Agent

```typescript
import { Wraith, Chain } from "@wraith-protocol/sdk";

const wraith = new Wraith({ apiKey: "wraith_..." });

const agent = await wraith.createAgent({
  name: "alice",
  chain: Chain.Horizen,
  wallet: "0x...",
  signature: "0x...",
});
```

### 3. Send a Private Payment

```typescript
const response = await agent.chat("send 0.1 ETH to bob.wraith");
console.log(response.response);
// "Payment sent — 0.1 ETH to bob.wraith via stealth address 0x7a3f..."
```

### 4. Scan for Incoming Payments

```typescript
const response = await agent.chat("scan for incoming payments");
// Agent detects payments sent to your stealth addresses
```

## Supported Chains

| Chain | Family | Status | Native Asset |
|---|---|---|---|
| Horizen | EVM | Live | ETH |
| Ethereum | EVM | Planned | ETH |
| Polygon | EVM | Planned | MATIC |
| Base | EVM | Planned | ETH |
| Stellar | Stellar | Live | XLM |
| Solana | Solana | Planned | SOL |

Adding a new EVM chain requires only configuration (RPC URL + contract addresses). Adding a new chain family requires implementing the `ChainConnector` interface.

## Key Features

- **Stealth addresses** — every payment goes to a fresh one-time address. No on-chain link between sender and receiver.
- **Multichain** — one agent, multiple chains. Chat naturally and the AI routes to the right chain.
- **AI-powered** — natural language interface for payments, scanning, withdrawals, and privacy analysis.
- **TEE security** — private keys derived inside Intel TDX hardware enclaves. Never stored on disk.
- **Privacy scoring** — the agent proactively warns about timing analysis, address correlation, and other privacy risks.

## Next Steps

- [Getting Started](getting-started.md) — full setup walkthrough
- [SDK Overview](sdk/overview.md) — package structure and entry points
- [Architecture](architecture/overview.md) — how the system works under the hood
- [Stealth Payments Guide](guides/stealth-payments.md) — how stealth addresses work
