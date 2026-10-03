# Contributing

Thanks for helping improve the Wraith Protocol docs.

## Snippet checks

All TypeScript and JavaScript code fences in `.mdx` files are checked by:

```bash
npm run check:snippets
```

The checker extracts each `ts`, `tsx`, `typescript`, `js`, and `javascript` fence,
writes it to a temporary file, and runs `tsc --noEmit` against that snippet. The
initial gate is intentionally syntax-focused because many current docs snippets
are fragments meant to illustrate API shapes rather than complete programs. It
still catches malformed TypeScript and keeps the docs ready for stricter runtime
validation over time.

Use `no-check` only for intentionally illustrative pseudocode:

````mdx
```typescript no-check
// Pseudocode that is not copy-paste runnable.
```
````

Prefer making snippets compile over opting them out.

## Navigation coverage

Every `.mdx` page in the shipped taxonomy (root pages plus `architecture/`,
`api-reference/`, `contracts/`, `guides/`, `reference/`, and `sdk/`) must be
registered in the `docs.json` navigation tree, and every navigation entry must
resolve to a real file. This is enforced by:

```bash
npm run check:nav-coverage
```

The checker (`scripts/check-nav-coverage.mjs`) scans for `.mdx` files that are
missing from `docs.json` and for nav entries that point at files that no longer
exist. Run it after adding, renaming, or removing a page:

```bash
node scripts/check-nav-coverage.mjs
```

Note: `docs.json` is strict JSON — do not add `//` comments to it, the Mintlify
CLI rejects them. Keep this file comment-free.

## Contract registry

[`reference/contract-registry.mdx`](/reference/contract-registry) is the canonical
source for deployed contract addresses, versions, artifact hashes, and deployment
ledgers. Its machine-readable copy lives at `scripts/contract-registry.json`.

```bash
npm run check:contract-registry
```

The checker (`scripts/check-contract-registry.mjs`) validates the registry shape,
rejects stale contract placeholders anywhere in the shipped `.mdx` pages, confirms
every deployed address is documented, and verifies that the network guide, SDK,
quickstart, and contracts pages link back to the registry.

The registry is only canonical if it matches reality, so the checker also
cross-verifies it against pinned authoritative sources:

- **SDK manifest** — every address recorded under an `sdkKey` must exactly match
  `getDeployment()` from the `@wraith-protocol/sdk` version resolved by the
  lockfile, and every SDK-published contract must be recorded. The registry's
  `sdkVersion` must match the installed package version.
- **On-chain state** — for each live testnet contract, the WASM hash reported by
  the Stellar Expert API must equal the recorded `artifactHash`, the on-chain
  creation timestamp must fall on `deployedAt`, and the recorded
  `deploymentLedger` must close on `deployedAt` per Horizon.
- **Contracts manifest** — fetched at the commit recorded in
  `pinnedContractsRepoCommit`. Mainnet placeholder status (`C[TBD]` vs. real
  addresses) must agree between the registry and the manifest, and
  upgradeability claims must match the manifest's governance section.

The network checks run in CI on every PR. Locally you can skip them with:

```bash
node scripts/check-contract-registry.mjs --offline
```

When a deployment lands, update `scripts/contract-registry.json` first, then update
the pages that quote it. Never ship a placeholder contract id such as
`CPLACEHOLDER_*` or `C[TBD]` — CI fails on those patterns.

## CI

Every pull request runs the snippet checker, the nav coverage check, and the
contract registry check through GitHub Actions. A separate non-blocking Stellar
testnet job is reserved for end-to-end snippet validation that depends on network
availability. The workflow also runs extended snippet validation and the
redirect and anchor checks, including their unit tests.

## Mintlify preview redirect check

After Mintlify publishes the pull request preview, run the smoke check from
this PR's checkout, supplying the actual preview base URL (for example,
`https://example.mintlify.app`). On macOS/Linux:

```bash
MINTLIFY_PREVIEW_URL=https://example.mintlify.app \
pnpm run test:preview-redirect
```

In PowerShell:

```powershell
$env:MINTLIFY_PREVIEW_URL = "https://example.mintlify.app"
pnpm run test:preview-redirect
```

The check makes a real request to `/README`, does not follow redirects, and
requires a 3xx response with a `Location` resolving to `/introduction`. The
repository's GitHub Actions workflows do not expose the Mintlify preview URL.
GitHub also requires a `workflow_dispatch` workflow to exist on the default
branch before it can be manually dispatched, so this PR uses the documented
command against the preview URL instead of adding a workflow that cannot yet
be run for this PR.
