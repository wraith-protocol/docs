# Bring Your Own Model

By default, Wraith agents use a hosted Gemini model. You can replace it with OpenAI, Claude, or your own Gemini key to reduce cost or use a specific model.

## Configuration

Pass the `ai` option when creating the `Wraith` client:

```typescript
import { Wraith, Chain } from "@wraith-protocol/sdk";

const wraith = new Wraith({
  apiKey: "wraith_live_abc123",
  ai: {
    provider: "openai",
    apiKey: "sk-...",
  },
});
```

All agents created from this client will use your specified AI provider.

## Supported Providers

| Provider | `ai.provider` | API Key Format |
|---|---|---|
| Google Gemini | `"gemini"` | Gemini API key |
| OpenAI | `"openai"` | `sk-...` |
| Anthropic Claude | `"claude"` | Anthropic API key |

### OpenAI

```typescript
const wraith = new Wraith({
  apiKey: "wraith_live_abc123",
  ai: {
    provider: "openai",
    apiKey: "sk-proj-...",
  },
});

const agent = await wraith.createAgent({
  name: "alice",
  chain: Chain.Horizen,
  wallet: "0x...",
  signature: "0x...",
});

// Chat uses your OpenAI key
const res = await agent.chat("send 0.1 ETH to bob.wraith");
```

### Claude

```typescript
const wraith = new Wraith({
  apiKey: "wraith_live_abc123",
  ai: {
    provider: "claude",
    apiKey: "sk-ant-...",
  },
});
```

### Your Own Gemini Key

```typescript
const wraith = new Wraith({
  apiKey: "wraith_live_abc123",
  ai: {
    provider: "gemini",
    apiKey: "AIza...",
  },
});
```

## How It Works

The AI configuration is passed to the TEE server via HTTP headers on every request:

| Header | Value |
|---|---|
| `Authorization` | `Bearer wraith_...` (your Wraith API key) |
| `X-AI-Provider` | `openai`, `claude`, or `gemini` |
| `X-AI-Key` | Your AI provider API key |

The TEE server:
1. Receives your chat message
2. Builds the system prompt with agent identity and tools
3. Sends the conversation to your specified AI provider
4. Executes any tool calls via the chain connector
5. Returns the final response

Your AI key is only used server-side in the TEE. It's never stored — used for the duration of the request only.

## Default vs. BYOM

| Aspect | Default (Gemini) | Bring Your Own |
|---|---|---|
| Cost | Included in Wraith API usage | You pay your AI provider directly |
| Model | Wraith's chosen Gemini model | Your choice |
| Latency | Optimized routing | Depends on your provider |
| Configuration | None | Pass `ai` option |

## Mixed Usage

You can create multiple `Wraith` instances with different AI configurations:

```typescript
// One with default Gemini
const wraithDefault = new Wraith({
  apiKey: "wraith_live_abc123",
});

// One with OpenAI
const wraithOpenAI = new Wraith({
  apiKey: "wraith_live_abc123",
  ai: { provider: "openai", apiKey: "sk-..." },
});

// Different agents use different AI providers
const agent1 = await wraithDefault.createAgent({ ... });
const agent2 = await wraithOpenAI.createAgent({ ... });
```

## Tool Compatibility

All 16+ tools work identically regardless of the AI provider. The tool declarations are adapted to each provider's function-calling format by the TEE server. Your code doesn't change.

```typescript
// This works the same with Gemini, OpenAI, or Claude
const res = await agent.chat("send 0.1 ETH to bob.wraith");
const res = await agent.chat("run a privacy check");
const res = await agent.chat("create an invoice for 1 ETH");
```
