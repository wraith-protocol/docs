# Multichain Agent

A multichain agent has one `.wraith` name with identities on multiple chains. The AI agent is chain-aware — chat naturally and it routes to the right chain.

## Create a Multichain Agent

Pass an array of chains instead of a single chain:

```typescript
import { Wraith, Chain } from "@wraith-protocol/sdk";

const wraith = new Wraith({ apiKey: "wraith_live_abc123" });

const agent = await wraith.createAgent({
  name: "alice",
  chain: [Chain.Horizen, Chain.Stellar, Chain.Ethereum],
  wallet: "0xYourWallet",
  signature: "0xSignature",
});
```

The agent gets a separate address and stealth meta-address on each chain:

```typescript
console.log(agent.info.chains);
// [Chain.Horizen, Chain.Stellar, Chain.Ethereum]

console.log(agent.info.addresses);
// {
//   horizen: "0xabc...",
//   stellar: "GABC...",
//   ethereum: "0xdef..."
// }

console.log(agent.info.metaAddresses);
// {
//   horizen: "st:eth:0x...",
//   stellar: "st:xlm:...",
//   ethereum: "st:eth:0x..."
// }
```

## Deploy on All Chains

Use `Chain.All` to deploy on every chain the platform supports:

```typescript
const agent = await wraith.createAgent({
  name: "alice",
  chain: Chain.All,
  wallet: "0xYourWallet",
  signature: "0xSignature",
});
```

## Chain-Aware Chat

The AI agent infers the chain from context. When it can't, it asks.

### Explicit Chain

```typescript
await agent.chat("send 0.1 ETH to bob.wraith on horizen");
await agent.chat("send 10 XLM to carol.wraith on stellar");
```

### Inferred Chain

```typescript
await agent.chat("send 10 XLM to carol.wraith");
// XLM -> Stellar (unambiguous)

await agent.chat("send 100 ZEN to bob.wraith");
// ZEN -> Horizen (unambiguous)
```

### Ambiguous Cases

```typescript
await agent.chat("send 0.1 ETH to bob.wraith");
// "ETH exists on both Horizen and Ethereum. Which chain do you mean?"

await agent.chat("horizen");
// "Payment sent — 0.1 ETH to bob.wraith on Horizen..."
```

## Cross-Chain Balance

```typescript
await agent.chat("what's my balance on all chains?");
// "Balances:
//  Horizen: 1.5 ETH, 100 ZEN, 50 USDC
//  Stellar: 500 XLM
//  Ethereum: 0.3 ETH"
```

## Cross-Chain Scanning

```typescript
await agent.chat("scan for payments on all chains");
// "Incoming payments:
//  Horizen:
//  - 0.1 ETH at 0xabc...
//  Stellar:
//  - 10 XLM at GABC..."
```

## How It Works

Under the hood, a multichain agent is a single entity with multiple chain registrations. The TEE derives different keys per chain using the derivation path:

```
wraith/agent/{agentId}/horizen   -> secp256k1 keys
wraith/agent/{agentId}/stellar   -> ed25519 keys
wraith/agent/{agentId}/ethereum  -> secp256k1 keys
```

The AI agent's system prompt includes all chain identities, so it knows which chains the agent operates on and can route tool calls to the correct chain connector.

## Privacy Across Chains

Each chain has independent stealth address activity. Payments on Horizen are not visible on Stellar. The privacy check analyzes each chain separately:

```typescript
await agent.chat("run privacy check on all chains");
// "Privacy Analysis:
//  Horizen: Score 85/100
//  - 5 unspent stealth addresses
//  Stellar: Score 95/100
//  - All clear"
```

## Single vs. Multichain

| Feature | Single-Chain | Multichain |
|---|---|---|
| Chains | One | Multiple |
| Addresses | One | One per chain |
| Meta-addresses | One | One per chain |
| Chat | Direct routing | AI infers chain |
| Key derivation | One path | One path per chain |
| Privacy | One chain analysis | Per-chain analysis |

Both use the same SDK interface. The only difference is the `chain` parameter at creation time.
