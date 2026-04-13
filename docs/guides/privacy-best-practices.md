# Privacy Best Practices

Stealth addresses provide strong privacy by default. But certain usage patterns can degrade that privacy. This guide explains what to avoid and how the Wraith agent helps.

## Privacy Scoring

The Wraith agent includes a privacy check tool that scores your stealth address activity:

```typescript
import { Wraith, Chain } from "@wraith-protocol/sdk";

const wraith = new Wraith({ apiKey: "wraith_..." });
const agent = await wraith.createAgent({
  name: "alice",
  chain: Chain.Horizen,
  wallet: "0x...",
  signature: "0x...",
});

const res = await agent.chat("run a privacy check");
// Privacy Score: 85/100
// Issues:
// - (medium) 7 unspent stealth addresses — consider consolidating
// - (high) All recent payments are the same amount
// Best Practices:
// - Use a fresh destination for each withdrawal
// - Space withdrawals at least 1 hour apart
```

### Scoring Algorithm

The privacy check starts at 100 points and deducts for observed risks:

| Condition | Deduction | Severity |
|---|---|---|
| More than 5 unspent stealth addresses | -10 | Medium |
| All payment amounts identical | -15 | High |
| Consecutive payments less than 60 seconds apart | -20 | High |
| Never withdrawn any payments | -5 | Info |
| Connected wallet is the agent address | -5 | Info |

## What to Avoid

### 1. Withdrawing to the Same Address

**Bad:** Withdraw all stealth addresses to one known wallet.

```
Stealth Address 1 (0.1 ETH) -> 0xMyMainWallet
Stealth Address 2 (0.2 ETH) -> 0xMyMainWallet
Stealth Address 3 (0.5 ETH) -> 0xMyMainWallet

Observer: "These three stealth addresses all belong to the same person"
```

**Good:** Use a different destination for each withdrawal.

```
Stealth Address 1 -> 0xFresh1
Stealth Address 2 -> 0xFresh2
Stealth Address 3 -> 0xFresh3

Observer: "Three unrelated withdrawals to three unrelated addresses"
```

The Wraith agent warns you automatically:

```typescript
await agent.chat("withdraw all to 0xMyMainWallet");
// "Privacy concern — withdrawing all stealth addresses to a single
//  known wallet links every payment to your identity."
```

### 2. Timing Correlation

**Bad:** Withdraw multiple stealth addresses within seconds of each other.

```
14:00:00 — Withdraw from 0xStealth1
14:00:02 — Withdraw from 0xStealth2
14:00:04 — Withdraw from 0xStealth3

Observer: "These three transactions happened in 4 seconds.
           Probably the same person."
```

**Good:** Space withdrawals hours or days apart.

```
Monday 09:00   — Withdraw from 0xStealth1
Tuesday 15:30  — Withdraw from 0xStealth2
Thursday 11:15 — Withdraw from 0xStealth3
```

### 3. Amount Fingerprinting

**Bad:** Always send the exact same amount.

```
Send 0.100000 ETH to Stealth1
Send 0.100000 ETH to Stealth2
Send 0.100000 ETH to Stealth3

Observer: "Same amount, same pattern — likely the same sender"
```

**Good:** Vary amounts slightly.

```
Send 0.098372 ETH to Stealth1
Send 0.102841 ETH to Stealth2
Send 0.099127 ETH to Stealth3
```

### 4. Address Reuse

**Bad:** Reuse a stealth address for multiple payments.

Stealth addresses are designed to be one-time. The Wraith protocol enforces this — each payment generates a fresh address automatically. But if you're building custom integrations with the [EVM crypto primitives](../sdk/chains/evm.md), make sure you call `generateStealthAddress()` for each payment.

### 5. Linking On-Chain Identity

**Bad:** Withdraw from a stealth address directly to a wallet tied to your ENS, `.wraith` name, or known identity.

**Good:** Use an intermediate address with no on-chain identity.

## How the Agent Helps

The Wraith AI agent is designed to be privacy-paranoid. It will:

- **Warn before risky actions** — if you ask to withdraw all to one address, it explains the risk first
- **Suggest alternatives** — recommends fresh addresses, spacing, and varied amounts
- **Run privacy checks** — analyzes your activity and flags patterns
- **Remember context** — if you've made risky moves before, it factors that into future advice
- **Respect your decision** — after warning, it will execute if you insist

### Example: Agent Warning

```typescript
await agent.chat("withdraw all to 0xMyMainWallet");
```

Agent response:
```
Privacy concern — withdrawing all stealth addresses to a single
known wallet links every payment to your identity. Observers can
trace all incoming stealth payments back to you.

Recommendations:
- Use a fresh address for each withdrawal
- Space withdrawals hours apart
- Withdraw to different destinations

Proceed anyway? Or would you like me to suggest a safer approach?
```

### Example: Proactive Detection

```typescript
await agent.chat("send 0.1 ETH to bob.wraith");
// ... minutes later ...
await agent.chat("send 0.1 ETH to carol.wraith");
// ... minutes later ...
await agent.chat("send 0.1 ETH to dave.wraith");
```

Agent response on the third send:
```
Payment sent. Note: your last 3 payments were all exactly 0.1 ETH.
Identical amounts create a fingerprint that can link your transactions.
Consider varying the amount slightly for future payments.
```

## Best Practices Summary

| Practice | Why |
|---|---|
| Use a fresh destination for each withdrawal | Prevents linking stealth addresses to one identity |
| Space withdrawals at least 1 hour apart | Defeats timing correlation analysis |
| Never withdraw to your connected wallet | Keeps your identity separate from stealth activity |
| Vary payment amounts slightly | Prevents amount-based fingerprinting |
| Use different times of day | Avoids timezone-based profiling |
| Consolidate stealth addresses periodically | Reduces on-chain footprint |
