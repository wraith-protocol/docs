# Single-Chain Agent

Create an agent on one chain and interact with it. This guide walks through the full lifecycle: creation, funding, payments, scanning, withdrawals, invoicing, and privacy.

## Prerequisites

```bash
npm install @wraith-protocol/sdk
```

You need:
- A Wraith API key
- A wallet that can sign messages (MetaMask, viem, ethers, etc.)

## Create the Agent

```typescript
import { Wraith, Chain } from "@wraith-protocol/sdk";

const wraith = new Wraith({ apiKey: "wraith_live_abc123" });

// Sign a message to prove wallet ownership
const message = "Sign to create Wraith agent";
const signature = await wallet.signMessage(message);

const agent = await wraith.createAgent({
  name: "alice",
  chain: Chain.Horizen,
  wallet: walletAddress,
  signature: signature,
  message: message,
});
```

The agent is now live on Horizen with:
- A `.wraith` name: `alice.wraith`
- An on-chain address for receiving direct transfers
- A stealth meta-address for receiving private payments
- An AI agent inside the TEE

```typescript
console.log(agent.info.name);                        // "alice"
console.log(agent.info.chains);                      // [Chain.Horizen]
console.log(agent.info.addresses[Chain.Horizen]);     // "0x..."
console.log(agent.info.metaAddresses[Chain.Horizen]); // "st:eth:0x..."
```

## Fund the Agent

On testnet, request tokens from the faucet:

```typescript
const res = await agent.chat("fund my wallet");
console.log(res.response);
// "Wallet funded with testnet ETH. Balance: 0.5 ETH"
```

## Check Balance

```typescript
const res = await agent.chat("what's my balance?");
console.log(res.response);
// "Balance: 0.5 ETH, 0 ZEN, 0 USDC"
```

Or programmatically:

```typescript
const balance = await agent.getBalance();
console.log(balance.native);  // "0.5"
console.log(balance.tokens);  // { ZEN: "0", USDC: "0" }
```

## Send a Stealth Payment

```typescript
const res = await agent.chat("send 0.1 ETH to bob.wraith");
console.log(res.response);
// "Payment sent — 0.1 ETH to bob.wraith via stealth address 0x7a3f..."
// [tx](https://horizen-testnet.explorer.caldera.xyz/tx/0xabc...)
```

The agent:
1. Resolves `bob.wraith` to a stealth meta-address
2. Generates a one-time stealth address
3. Sends ETH to the stealth address
4. Publishes an on-chain announcement

## Scan for Incoming Payments

```typescript
const res = await agent.chat("scan for payments");
console.log(res.response);
// "Found 2 incoming payments:
//  - 0.1 ETH at 0xabc... (balance: 0.1 ETH)
//  - 0.05 ETH at 0xdef... (balance: 0.05 ETH)"
```

## Withdraw

### Withdraw from a specific stealth address

```typescript
const res = await agent.chat("withdraw 0.05 ETH from 0xabc... to 0xMyWallet");
```

### Withdraw everything

```typescript
const res = await agent.chat("withdraw all to 0xMyWallet");
// The agent will warn about privacy risks first:
// "Privacy concern — withdrawing all stealth addresses to a single
//  known wallet links every payment to your identity.
//  Recommendations:
//  - Use a fresh address for each withdrawal
//  - Space withdrawals hours apart
//  Proceed anyway?"
```

## Create an Invoice

```typescript
const res = await agent.chat("create an invoice for 0.5 ETH with memo design work");
console.log(res.response);
// "Invoice created — [Pay 0.5 ETH](https://pay.wraith.dev/invoice/uuid)"
```

Check invoice status:

```typescript
const res = await agent.chat("check my invoices");
// "1 invoice:
//  - 0.5 ETH (design work) — pending"
```

## Schedule Recurring Payments

```typescript
const res = await agent.chat("schedule 0.1 ETH to bob.wraith every week");
console.log(res.response);
// "Scheduled: 0.1 ETH to bob.wraith weekly, next run in 7 days"
```

Manage schedules:

```typescript
await agent.chat("list my schedules");
await agent.chat("cancel schedule abc-123");
```

## Privacy Check

```typescript
const res = await agent.chat("run a privacy check");
console.log(res.response);
// "Privacy Score: 90/100
//  Issues:
//  - (info) 3 unspent stealth addresses
//  Best Practices:
//  - Use a fresh destination for each withdrawal
//  - Space withdrawals at least 1 hour apart
//  - Vary payment amounts slightly"
```

## Notifications

```typescript
const { notifications, unreadCount } = await agent.getNotifications();
console.log(unreadCount); // 2

// Mark as read
await agent.markNotificationsRead();

// Clear all
await agent.clearNotifications();
```

## Conversations

The agent maintains conversation history for context:

```typescript
// Start a conversation
const res1 = await agent.chat("send 0.1 ETH to bob.wraith");
const convId = res1.conversationId;

// Continue the same conversation
const res2 = await agent.chat("what was the tx hash?", convId);
// Agent remembers the previous message and provides the hash

// List conversations
const conversations = await agent.getConversations();

// Get messages from a conversation
const messages = await agent.getMessages(convId);

// Delete a conversation
await agent.deleteConversation(convId);
```

## Export Private Key

If you need the agent's raw private key (e.g., to use outside Wraith):

```typescript
const exportSig = await wallet.signMessage(
  "Export private key for agent " + agent.info.id
);
const { secret } = await agent.exportKey(
  exportSig,
  "Export private key for agent " + agent.info.id
);
console.log(secret); // "0x..." — the agent's private key
```

This requires a fresh wallet signature from the owner. Nobody — including Wraith — can export the key without the owner's authorization.

## Reconnecting

If you already have an agent, reconnect without creating a new one:

```typescript
// By agent ID
const agent = wraith.agent("agent-uuid");

// By owner wallet
const agent = await wraith.getAgentByWallet("0xMyWallet");

// By .wraith name
const agent = await wraith.getAgentByName("alice");
```
