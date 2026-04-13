# Chain Connectors

Chain connectors are the abstraction layer between Wraith's chain-agnostic agent core and blockchain-specific logic. Each connector implements a standard interface, allowing the same agent engine to operate across any supported chain.

## Interface

Every chain connector implements `ChainConnector`:

```typescript
interface ChainConnector {
  readonly chain: string;
  readonly nativeAsset: string;
  readonly addressFormat: "evm" | "stellar" | "solana";

  deriveKeys(seed: Uint8Array): Promise<DerivedKeys>;

  sendPayment(params: SendPaymentParams): Promise<TxResult>;
  scanPayments(stealthKeys: ChainStealthKeys): Promise<DetectedPayment[]>;
  getBalance(address: string): Promise<ChainBalance>;
  withdraw(params: WithdrawParams): Promise<TxResult>;
  withdrawAll(params: WithdrawAllParams): Promise<WithdrawAllResult>;

  registerName(name: string, stealthKeys: ChainStealthKeys): Promise<TxResult>;
  resolveName(name: string): Promise<ResolvedName | null>;

  fundWallet(address: string): Promise<TxResult>;

  getExplorerUrl(type: "tx" | "address", value: string): string;
}
```

### Supporting Types

```typescript
interface DerivedKeys {
  address: string;
  stealthKeys: ChainStealthKeys;
  metaAddress: string;
}

interface ChainStealthKeys {
  [key: string]: unknown;  // opaque to the core — each chain stores what it needs
}

interface SendPaymentParams {
  senderAddress: string;
  senderStealthKeys: ChainStealthKeys;
  recipientMetaAddress: string;
  amount: string;
  asset?: string;
}

interface WithdrawParams {
  stealthKeys: ChainStealthKeys;
  from: string;
  to: string;
  amount?: string;  // undefined = withdraw max
}

interface WithdrawAllParams {
  stealthKeys: ChainStealthKeys;
  to: string;
}

interface DetectedPayment {
  stealthAddress: string;
  balance: string;
  ephemeralPubKey: string;
}

interface ChainBalance {
  native: string;
  tokens: Record<string, string>;
}

interface ResolvedName {
  name: string;
  metaAddress: string;
  address?: string;
}

interface TxResult {
  txHash: string;
  txLink: string;
}

interface WithdrawAllResult {
  results: Array<{ address: string } & (TxResult | { error: string })>;
  count: number;
  totalWithdrawn: string;
}
```

---

## EVM Connector

A single `EVMConnector` class covers all EVM-compatible chains. Different chains use different configuration — same code.

### Configuration

```typescript
interface EVMConnectorConfig {
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  contracts: {
    announcer: `0x${string}`;
    registry: `0x${string}`;
    sender: `0x${string}`;
    names: `0x${string}`;
  };
  subgraphUrl?: string;
  faucetUrl?: string;
  tokens?: Record<string, { address: string; decimals: number }>;
}
```

### How Methods Map to SDK Primitives

| Interface Method | Implementation |
|---|---|
| `deriveKeys(seed)` | SHA-256 seed -> `privateKeyToAccount` -> sign message -> `deriveStealthKeys(sig)` -> `encodeStealthMetaAddress` |
| `sendPayment` | `decodeStealthMetaAddress` -> `generateStealthAddress` -> `writeContract(WraithSender, "sendETH")` |
| `scanPayments` | Query subgraph for Announcement events -> `scanAnnouncements(events, ...)` -> fetch balances |
| `getBalance` | `publicClient.getBalance` + `readContract(erc20, balanceOf)` per token |
| `withdraw` | `deriveStealthPrivateKey` -> `privateKeyToAccount` -> `sendTransaction` |
| `registerName` | `signNameRegistration(name, metaBytes, spendingKey)` -> `writeContract(WraithNames, "register")` |
| `resolveName` | `readContract(WraithNames, "resolve", [name])` -> decode meta-address |
| `fundWallet` | POST to faucet API (testnet) |
| `getExplorerUrl` | `${explorerUrl}/tx/${hash}` or `${explorerUrl}/address/${addr}` |

### Adding a New EVM Chain

No code changes required. Register a new chain with its config:

```typescript
import { Chain } from "@wraith-protocol/sdk";

// Horizen Testnet
chainRegistry.register(Chain.Horizen, new EVMConnector({
  chainId: 2651420,
  rpcUrl: "https://horizen-testnet.rpc.caldera.xyz/http",
  explorerUrl: "https://horizen-testnet.explorer.caldera.xyz",
  contracts: {
    announcer: "0x8AE65c05E7eb48B9bA652781Bc0a3DBA09A484F3",
    registry: "0x953E6cEdcdfAe321796e7637d33653F6Ce05c527",
    sender: "0x226C5eb4e139D9fa01cc09eA318638b090b12095",
    names: "0x3d46f709a99A3910f52bD292211Eb5D557F882D6",
  },
  subgraphUrl: "https://api.goldsky.com/api/public/...",
  tokens: {
    ETH: { address: "native", decimals: 18 },
    ZEN: { address: "0x4b36cb6E...", decimals: 18 },
    USDC: { address: "0x01c7AEb2...", decimals: 6 },
  },
}));

// Ethereum Mainnet — same connector, different config
chainRegistry.register(Chain.Ethereum, new EVMConnector({
  chainId: 1,
  rpcUrl: "https://eth-mainnet.g.alchemy.com/v2/...",
  explorerUrl: "https://etherscan.io",
  contracts: {
    announcer: "0x...",
    registry: "0x...",
    sender: "0x...",
    names: "0x...",
  },
}));
```

**Requirements for each new EVM chain:**
1. Deploy the 4 Solidity contracts (Announcer, Registry, Sender, Names)
2. Set up a subgraph to index Announcement events
3. Add config to the registry

---

## Stellar Connector

### How Methods Map to SDK Primitives

| Interface Method | Implementation |
|---|---|
| `deriveKeys(seed)` | SHA-256 seed -> ed25519 seed -> sign message -> `deriveStealthKeys(sig)` -> `encodeStealthMetaAddress` |
| `sendPayment` | `decodeStealthMetaAddress` -> `generateStealthAddress` -> `Operation.createAccount` -> Soroban announcer |
| `scanPayments` | Fetch Soroban events -> `scanAnnouncements(events, ...)` -> fetch balances from Horizon |
| `getBalance` | `GET /accounts/{key}` from Horizon |
| `withdraw` | `deriveStealthPrivateScalar` -> build payment tx -> `signStellarTransaction` -> submit to Horizon |
| `registerName` | Call Soroban WraithNames `register(name, metaAddress)` |
| `resolveName` | Simulate Soroban WraithNames `resolve(name)` |
| `fundWallet` | Stellar Friendbot `GET /friendbot?addr={key}` |
| `getExplorerUrl` | `https://stellar.expert/explorer/testnet/tx/${hash}` |

### Stellar-Specific Considerations

- **Account creation:** Stellar requires accounts to exist with a minimum balance (1 XLM). Sending to a new stealth address uses `Operation.createAccount`, not `Operation.payment`.
- **Signing:** Stealth private keys are derived scalars. Must use `signWithScalar()` from the SDK — can't use `Keypair.fromRawEd25519Seed()`.
- **Events:** Soroban contract events are fetched via `sorobanServer.getEvents()`, not a subgraph.

### Configuration

```typescript
const connector = new StellarConnector({
  networkPassphrase: Networks.TESTNET,
  horizonUrl: "https://horizon-testnet.stellar.org",
  sorobanUrl: "https://soroban-testnet.stellar.org",
  contracts: {
    announcer: "CCJLJ2QRBJAAKIG6ELNQVXLLWMKKWVN5O2FKWUETHZGMPAD4MHK7WVWL",
    names: "CC...",
  },
});
```

---

## Chain Registry

The TEE server maintains a registry of available chain connectors:

```typescript
class ChainRegistry {
  private connectors = new Map<string, ChainConnector>();

  register(chain: string, connector: ChainConnector): void {
    this.connectors.set(chain, connector);
  }

  get(chain: string): ChainConnector {
    const c = this.connectors.get(chain);
    if (!c) throw new Error(`Unsupported chain: "${chain}". Available: ${this.supportedChains().join(", ")}`);
    return c;
  }

  supportedChains(): string[] {
    return Array.from(this.connectors.keys());
  }
}
```

### Usage in Agent Service

```typescript
async sendPayment(agentId: string, recipient: string, amount: string) {
  const agent = await this.db.agents.findOneBy({ id: agentId });
  const connector = this.chainRegistry.get(agent.chain);
  const stealthKeys = await this.tee.deriveAgentStealthKeys(agentId, agent.chain);
  return connector.sendPayment({
    senderAddress: agent.address,
    senderStealthKeys: stealthKeys,
    recipientMetaAddress: recipient,
    amount,
  });
}
```

---

## Adding a New Chain Family

To add support for a completely new chain family (e.g., Solana):

1. **Create a connector class** implementing `ChainConnector`
2. **Implement all methods** using the chain's SDK and cryptographic primitives
3. **Write the crypto module** at `@wraith-protocol/sdk/chains/solana`
4. **Deploy stealth address contracts** on the target chain
5. **Register the connector** in the chain registry

The agent core, AI engine, storage, notifications, and scheduling work automatically — no changes needed.

### Key Differences Between Chain Families

| Aspect | EVM | Stellar | Solana |
|---|---|---|---|
| Curve | secp256k1 | ed25519 | ed25519 |
| Address format | `0x...` (20 bytes) | `G...` (56 chars) | Base58 |
| Meta-address prefix | `st:eth:0x` | `st:xlm:` | `st:sol:` |
| Contracts | Solidity | Soroban (Rust) | Solana Programs |
| Announcements | EVM events / subgraph | Soroban events / Horizon | Program log events |
| Native asset | ETH | XLM | SOL |
| Account model | Balance-based | Account must exist first | Balance-based |
