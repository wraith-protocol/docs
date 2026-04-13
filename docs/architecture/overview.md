# Architecture Overview

Wraith has three layers: the SDK (client library), the TEE infrastructure (managed by Wraith), and the blockchains.

## System Diagram

```
Developers
    |
    v
@wraith-protocol/sdk              <-- npm package (client library)
    |
    v
Wraith TEE Infrastructure         <-- managed by Wraith (Phala TEE)
    |
    v
Blockchains                       <-- Horizen, Stellar, Ethereum, ...
```

Developers never run servers, manage keys, or handle chain-specific crypto. They install the SDK, get an API key, and build.

## TEE Server Architecture

One NestJS server deployment with a chain connector registry. The core agent engine is chain-agnostic. Chain-specific logic lives behind a pluggable interface.

```
TEE Server
  |-- Core (chain-agnostic)
  |    |-- AI Engine (Gemini, or developer's own model)
  |    |-- Storage (PostgreSQL)
  |    |-- Session & Conversation Management
  |    |-- Notifications
  |    |-- Scheduled Payments
  |    +-- Tool Orchestration
  |
  |-- Chain Connector Registry
  |    |-- EVMConnector        -> Horizen, Ethereum, Polygon, Base, ...
  |    |-- StellarConnector    -> Stellar
  |    +-- SolanaConnector     -> Solana
  |
  +-- TEE Key Derivation (DStack)
       +-- Path: wraith/agent/{agentId}/{chain}
```

## Module Structure

```
src/
  main.ts                           <-- NestJS bootstrap
  app.module.ts                     <-- root module
  config/
    configuration.ts                <-- env vars config
  tee/
    tee.service.ts                  <-- DStack key derivation
    tee.controller.ts               <-- attestation endpoints
  agent/
    agent.controller.ts             <-- HTTP API (create, chat, export)
    agent.service.ts                <-- agent lifecycle, chat orchestration
    tools/
      tool-definitions.ts           <-- AI function declarations + system prompt
      agent-tools.service.ts        <-- tool execution
  storage/
    database.service.ts             <-- TypeORM repository access
    entities/                       <-- agent, conversation, invoice, etc.
  notifications/
    notification.service.ts         <-- create, list, mark read
  scheduler/
    scheduler.service.ts            <-- cron-based scheduled payments
  health/
    health.controller.ts            <-- /health endpoint
```

## Agent Lifecycle

### Creation

```
1. Client sends POST /agent/create { name, wallet, signature, chain }
2. Server verifies wallet signature (EIP-191 for EVM, ed25519 for Stellar)
3. Generate UUID for agent
4. Derive keys inside TEE: seed -> chain connector -> { address, stealthKeys, metaAddress }
5. Fund agent wallet via chain faucet (testnet)
6. Store agent in DB (id, name, chain, ownerWallet, address, metaAddress)
7. Register .wraith name on-chain
8. Return { id, name, chain, address, metaAddress }
```

### Chat Orchestration

The chat method runs a multi-turn tool-calling loop:

```
User message
    |
    v
Build chat context (system prompt + history + tools)
    |
    v
Send to AI model (Gemini / OpenAI / Claude)
    |
    v
Response type?
    |
    +-- TEXT --> Return final response
    |
    +-- FUNCTION CALL(s)
         |
         v
    Execute each tool via chain connector
         |
         v
    Return results to AI as functionResponse
         |
         v
    Loop back (AI may call more tools)
```

The AI can call multiple tools in one response. A cap (10 iterations) prevents infinite loops.

### Tool Execution

Each tool call routes to the appropriate chain connector:

```typescript
import { Chain } from "@wraith-protocol/sdk";

// The agent service resolves the connector automatically
async executeTool(toolName: string, args: Record<string, unknown>, agent: Agent) {
  const connector = this.chainRegistry.get(agent.chain);
  const stealthKeys = await this.tee.deriveStealthKeys(agent.id, agent.chain);

  switch (toolName) {
    case "send_payment":
      return connector.sendPayment({
        senderAddress: agent.address,
        senderStealthKeys: stealthKeys,
        recipientMetaAddress: args.recipient as string,
        amount: args.amount as string,
      });
    case "scan_payments":
      return connector.scanPayments(stealthKeys);
    case "get_balance":
      return connector.getBalance(agent.address);
    // ... 13 more tools
  }
}
```

## Database Schema

### agents

| Column | Type | Description |
|---|---|---|
| id | UUID (PK) | Agent identifier |
| name | VARCHAR | `.wraith` name (unique) |
| chain | VARCHAR | Target chain identifier |
| ownerWallet | VARCHAR | Owner's wallet address |
| address | VARCHAR | Agent's on-chain address |
| metaAddress | TEXT | Stealth meta-address |
| createdAt | TIMESTAMP | Creation time |

### conversations

| Column | Type | Description |
|---|---|---|
| id | UUID (PK) | Conversation identifier |
| agentId | UUID (FK) | References agents.id |
| title | VARCHAR | Conversation title |
| createdAt | TIMESTAMP | Created |
| updatedAt | TIMESTAMP | Last updated |

### messages

| Column | Type | Description |
|---|---|---|
| id | SERIAL (PK) | Message identifier |
| conversationId | UUID (FK) | References conversations.id |
| role | VARCHAR | `user`, `agent`, `tool`, or `system` |
| text | TEXT | Message content |
| createdAt | TIMESTAMP | Created |

### invoices

| Column | Type | Description |
|---|---|---|
| id | UUID (PK) | Invoice identifier |
| agentId | UUID (FK) | References agents.id |
| amount | VARCHAR | Payment amount |
| asset | VARCHAR | Asset symbol |
| memo | TEXT | Invoice description |
| status | VARCHAR | `pending` or `paid` |
| txHash | VARCHAR | Transaction hash (null until paid) |
| createdAt | TIMESTAMP | Created |

### notifications

| Column | Type | Description |
|---|---|---|
| id | SERIAL (PK) | Notification identifier |
| agentId | UUID (FK) | References agents.id |
| type | VARCHAR | Notification type |
| title | VARCHAR | Title |
| body | TEXT | Body |
| read | BOOLEAN | Read status |
| createdAt | TIMESTAMP | Created |

### scheduled_payments

| Column | Type | Description |
|---|---|---|
| id | UUID (PK) | Schedule identifier |
| agentId | UUID (FK) | References agents.id |
| recipient | VARCHAR | `.wraith` name or meta-address |
| amount | VARCHAR | Payment amount |
| asset | VARCHAR | Asset symbol |
| interval | VARCHAR | `daily`, `weekly`, or `monthly` |
| status | VARCHAR | `active`, `paused`, or `cancelled` |
| lastRun | TIMESTAMP | Last execution (null if never) |
| nextRun | TIMESTAMP | Next scheduled execution |
| createdAt | TIMESTAMP | Created |

## Platform Model

Wraith operates as a managed service, similar to Privy or Turnkey.

### What Wraith Manages

- TEE infrastructure (Phala deployment)
- Key derivation and security
- Chain connectors and RPC endpoints
- Database and session storage
- Name registration and gas sponsorship
- Payment scanning and notifications

### AI Model Options

| Option | Description |
|---|---|
| Default | Wraith's hosted Gemini model (included in API usage) |
| Bring Your Own | Pass your own OpenAI/Claude/Gemini API key |

```typescript
import { Wraith } from "@wraith-protocol/sdk";

// Default — uses Wraith's Gemini
const wraith = new Wraith({ apiKey: "wraith_..." });

// Bring your own model
const wraith = new Wraith({
  apiKey: "wraith_...",
  ai: { provider: "openai", apiKey: "sk-..." },
});
```
