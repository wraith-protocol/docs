# Wraith Protocol Docs

You are building the documentation for the Wraith Protocol — a multichain stealth address platform.

## Source Material

All content exists in `reference/docs/`. Your job is to turn these implementation guides into polished documentation for developers.

## Structure

All markdown files go in the repo root — no nested `docs/` folder. Use subdirectories for organization:

```
README.md                         # Landing — what is Wraith Protocol, navigation
getting-started.md                # Install SDK, create first agent, send payment
sdk/
  overview.md                     # SDK entry points, Chain enum
  agent-client.md                 # Wraith, WraithAgent classes, all methods
  chains/
    evm.md                        # EVM crypto primitives API
    stellar.md                    # Stellar crypto primitives API
architecture/
  overview.md                     # System diagram, how it all fits
  chain-connectors.md             # ChainConnector interface, adding chains
  tee.md                          # TEE security model, key derivation
guides/
  single-chain-agent.md           # Create agent on one chain
  multichain-agent.md             # Create agent on multiple chains
  bring-your-own-model.md         # Use OpenAI/Claude instead of Gemini
  stealth-payments.md             # How stealth addresses work (visual)
  privacy-best-practices.md       # Privacy scoring, what to avoid
contracts/
  evm.md                          # EVM contract specs + deployment
  stellar.md                      # Stellar contract specs + deployment
api-reference/
  endpoints.md                    # Full HTTP API reference
  types.md                        # TypeScript types reference
roadmap.md                        # Full roadmap with phases
```

## Roadmap Content

The `roadmap.md` should have 5 phases with detail under each item. Use checkboxes for status.

### Phase 1 — Foundation (done)
- [x] Stealth address cryptography — secp256k1 (EVM) and ed25519 (Stellar)
- [x] ERC-5564 (Stealth Address Messenger) and ERC-6538 (Stealth Meta-Address Registry) implementations
- [x] Smart contracts — Solidity (EVM) and Soroban/Rust (Stellar)
- [x] Atomic send-and-announce (WraithSender) — transfer + announcement in one transaction
- [x] Batch send and batch withdraw — multiple stealth addresses in one transaction
- [x] Gas-sponsored withdrawals via EIP-7702 (WraithWithdrawer)
- [x] Human-readable .wraith names — on-chain name registry, spending key ownership, no wallet address stored
- [x] Subgraph indexing via Goldsky — real-time announcement indexing
- [x] AI agent system — Gemini integration, 17 tools, natural language stealth payments
- [x] TEE deployment — Phala TEE (Intel TDX), DStack key derivation, keys never stored
- [x] Payment links and invoicing — shareable URLs, QR codes, payment status tracking
- [x] Scheduled payments — recurring stealth payments with pause/resume/cancel
- [x] Privacy analysis — scoring engine, timing pattern detection, address correlation warnings

### Phase 2 — Unified Platform (in progress)
- [x] Unified SDK (`@wraith-protocol/sdk`) — single package, three entry points
- [x] EVM chain crypto module (`@wraith-protocol/sdk/chains/evm`)
- [x] Stellar chain crypto module (`@wraith-protocol/sdk/chains/stellar`)
- [x] Agent client SDK — Wraith/WraithAgent classes, Chain enum with `All` option
- [ ] Spectre TEE server — multichain NestJS server with chain connector architecture
- [ ] EVM chain connector — single connector covering all EVM chains via config
- [ ] Stellar chain connector
- [ ] Developer documentation

### Phase 3 — Platform Launch
- [ ] Managed API — developer API keys, authentication, rate limiting
- [ ] Developer dashboard — usage analytics, agent management, billing
- [ ] Additional EVM chain deployments — each is config + contract deployment, no code changes:
  - Ethereum mainnet
  - Base
  - Polygon
  - Arbitrum
  - Optimism
  - (any EVM chain — same connector, same contracts)
- [ ] Cross-chain agent operations — single agent operating across multiple chains simultaneously
- [ ] Mobile SDK compatibility — ensure `@wraith-protocol/sdk` works in React Native / Expo

### Phase 4 — Chain Expansion
- [ ] Non-EVM chain integrations — each requires a new chain connector and contract set, but the agent core, AI, storage, and tools stay identical:
  - Solana (ed25519 — crypto reusable from Stellar, new Solana programs)
  - Starknet (STARK-friendly curve, Cairo contracts)
  - Sui (ed25519 — crypto reusable, Move contracts)
  - Aptos (ed25519 — crypto reusable, Move contracts)
  - TON (ed25519 — crypto reusable, FunC/Tact contracts)
- [ ] On-chain private messaging — ECDH encrypted messages using existing stealth meta-address keys, sender anonymous, no new key infrastructure
- [ ] ERC-4337 Paymaster — alternative to EIP-7702 for smart contract wallet compatibility
- [ ] Mobile app / PWA — consumer-facing mobile experience

### Phase 5 — Research
- [ ] FHE-DKSAP — Fully Homomorphic Encryption-based Dual Key Stealth Address Protocol for trustless outsourced scanning. A scanning service finds incoming transfers without ever seeing the viewing key.

Explain why EVM chain expansion is fast (same connector, same contracts, just config) vs non-EVM chains needing new connectors and contract sets. Note that ed25519 crypto from Stellar is reusable for Solana, Sui, Aptos, and TON. Starknet is a special case with a different curve.

## Audience

Developers integrating stealth payments. Assume they know TypeScript and basic blockchain concepts. Do NOT assume they know stealth address cryptography — explain it clearly.

## Tone

Technical but approachable. Short sentences. Code examples for everything. No marketing fluff.

## Rules

- NEVER add Co-Authored-By lines to commits
- NEVER commit, modify, or delete anything in the reference/ folder — it is gitignored and read-only
- All commit messages MUST follow conventional commits format (feat:, fix:, chore:, docs:)
- Commit after each section is complete and push to origin
- Every page should have working code examples
- Use `@wraith-protocol/sdk` as the package name everywhere
- Reference the `Chain` enum, not raw strings
- All code examples should be TypeScript
