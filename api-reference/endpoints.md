# HTTP API Reference

The TEE server exposes a REST API. The SDK's `Wraith` and `WraithAgent` classes wrap these endpoints — most developers don't call them directly.

## Authentication

All requests require an API key:

```
Authorization: Bearer wraith_live_abc123
```

Optional BYOM headers:

```
X-AI-Provider: openai
X-AI-Key: sk-...
```

---

## Agent Endpoints

### Create Agent

```
POST /agent/create
```

Create a new agent with a `.wraith` name.

**Request:**

```typescript
{
  name: string;          // "alice" (becomes alice.wraith)
  chain: string;         // "horizen" | "stellar" | "ethereum" | ...
  wallet: string;        // owner wallet address
  signature: string;     // EIP-191 or ed25519 signature
  message?: string;      // signed message (for verification)
}
```

**Response:**

```typescript
{
  id: string;            // UUID
  name: string;          // "alice"
  chain: string;         // "horizen"
  address: string;       // agent's on-chain address
  metaAddress: string;   // stealth meta-address
}
```

### List Agents

```
GET /agents
```

Returns all agents for the authenticated API key.

**Response:** `AgentInfo[]`

### Get Agent by ID

```
GET /agent/:id
```

**Response:** `AgentInfo`

### Get Agent by Name

```
GET /agent/info/:name
```

Look up an agent by `.wraith` name.

**Response:** `AgentInfo`

### Get Agent by Wallet

```
GET /agent/wallet/:address
```

Look up an agent by owner wallet address.

**Response:** `AgentInfo`

### Get Agent Status

```
GET /agent/:id/status
```

Returns balance, pending invoices, and other stats.

**Response:**

```typescript
{
  balance: string;
  tokens: Record<string, string>;
  pendingInvoices: number;
  address: string;
  metaAddress: string;
  chain: string;
}
```

### Export Private Key

```
POST /agent/:id/export
```

Export the agent's private key. Requires a fresh wallet signature.

**Request:**

```typescript
{
  signature: string;     // fresh signature from owner wallet
  message: string;       // signed message
}
```

**Response:**

```typescript
{
  secret: string;        // "0x..." — the agent's private key
}
```

---

## Chat

### Send Message

```
POST /agent/:id/chat
```

Send a natural language message to the AI agent.

**Request:**

```typescript
{
  message: string;
  conversationId?: string;  // continue existing conversation
}
```

**Response:**

```typescript
{
  response: string;          // agent's text reply
  toolCalls?: ToolCall[];    // tools the agent executed
  conversationId: string;    // conversation ID for continuity
}
```

```typescript
interface ToolCall {
  name: string;              // "send_payment", "scan_payments", etc.
  status: string;            // "success" or "error"
  detail?: string;           // JSON string with tool result
}
```

---

## Conversations

### List Conversations

```
GET /agent/:id/conversations
```

**Response:** `Conversation[]`

```typescript
interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}
```

### Create Conversation

```
POST /agent/:id/conversations
```

**Response:** `Conversation`

### Get Messages

```
GET /agent/:id/conversations/:convId/messages
```

**Response:**

```typescript
Array<{
  role: "user" | "agent" | "tool" | "system";
  text: string;
  createdAt: string;
}>
```

### Delete Conversation

```
DELETE /agent/:id/conversations/:convId
```

---

## Invoices

### Get Invoice

```
GET /invoice/:id
```

**Response:**

```typescript
{
  id: string;
  agentName: string;
  amount: string;
  asset: string;
  memo: string;
  status: "pending" | "paid";
  txHash: string | null;
  paymentLink: string;
  createdAt: string;
}
```

### Mark Invoice Paid

```
POST /invoice/:id/paid
```

Idempotent — calling multiple times doesn't create duplicate notifications.

---

## Notifications

### List Notifications

```
GET /agent/:id/notifications
```

**Response:**

```typescript
{
  notifications: Notification[];
  unreadCount: number;
}
```

```typescript
interface Notification {
  id: number;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}
```

### Mark All Read

```
POST /agent/:id/notifications/read
```

### Clear All

```
DELETE /agent/:id/notifications
```

---

## TEE

### Health Check

```
GET /health
```

**Response:**

```typescript
{
  status: "ok";
}
```

### TEE Info

```
GET /tee/info
```

Returns TEE environment information.

### Remote Attestation

```
GET /tee/attest/:agentId
```

Returns cryptographic proof that the TEE is running authentic code and the agent's keys were derived correctly.

---

## Error Responses

All errors return JSON with a `message` field:

```typescript
{
  message: string;
  statusCode: number;
}
```

| Status Code | Meaning |
|---|---|
| 400 | Bad request (missing params, invalid signature) |
| 401 | Unauthorized (invalid API key) |
| 404 | Agent/invoice/conversation not found |
| 409 | Conflict (name already taken) |
| 500 | Server error |

### Example

```typescript
// 400 Bad Request
{
  "message": "Name must be 3-32 characters, lowercase alphanumeric and hyphens only",
  "statusCode": 400
}

// 401 Unauthorized
{
  "message": "Invalid API key",
  "statusCode": 401
}

// 409 Conflict
{
  "message": "Name 'alice' is already registered",
  "statusCode": 409
}
```
