# Search Tests

Run these checks in the Mintlify hosted search modal after deployment. The expected result should appear as the first result unless the query is intentionally broad; broad queries should still place the expected page in the visible result list.

| Query                    | Expected top result           | Why                                                  |
| ------------------------ | ----------------------------- | ---------------------------------------------------- |
| `quickstart`             | `getting-started.mdx`         | Common onboarding term.                              |
| `install sdk`            | `getting-started.mdx`         | First setup path should win over SDK internals.      |
| `create agent`           | `getting-started.mdx`         | Beginner flow before detailed API reference.         |
| `send private payment`   | `guides/stealth-payments.mdx` | Conceptual payment explanation.                      |
| `send stellar payment`   | `getting-started.mdx`         | Onboarding should surface before Stellar primitives. |
| `stellar quickstart`     | `sdk/chains/stellar.mdx`      | Stellar-specific SDK primitives.                     |
| `soroban`                | `contracts/stellar.mdx`       | Stellar smart contract docs.                         |
| `stellar smart contract` | `contracts/stellar.mdx`       | Synonym for Soroban.                                 |
| `friendbot`              | `getting-started.mdx`         | User-facing synonym for testnet funding.             |
| `testnet faucet`         | `getting-started.mdx`         | Same intent as friendbot/funding.                    |
| `metaaddress`            | `guides/stealth-payments.mdx` | No-hyphen variant of meta-address.                   |
| `meta address`           | `guides/stealth-payments.mdx` | Spaced variant of meta-address.                      |
| `unlinkable`             | `guides/stealth-payments.mdx` | Plain-language synonym for stealth privacy.          |
| `tee keys`               | `architecture/tee.mdx`        | Security/key derivation detail.                      |
| `api bearer token`       | `api-reference/endpoints.mdx` | Authentication reference.                            |
