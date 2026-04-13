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
```

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
