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

### API endpoint examples

`api-reference/endpoints.mdx` has a stricter gate, which `check:snippets` also runs:

```bash
npm run check:api-examples
```

The checker (`scripts/check-api-examples.ts`) compiles the page's TypeScript fences
together, in page order, as one `strict` module, then runs them offline against the
typed response fixtures in `scripts/fixtures/api-endpoint-responses.json`. Each
request must hit a route documented on the page, and each fixture is compiled with
`satisfies` against the response type it names.

When an example calls an endpoint, add one fixture per request it makes. `no-check`
is not allowed on that page.

### Python quickstart

`guides/quickstarts/python.mdx` runs end to end in CI, offline, as part of
`check:snippets-extended`:

```bash
npm run check:python-quickstart
```

`scripts/python-quickstart/run_quickstart.py` builds `wraith_crypto.py` from the
fence that starts with `# wraith_crypto.py` (plus any `# Add to wraith_crypto.py`
fences), then runs every other Python fence in page order in one session. The
Soroban RPC, Horizon, and Soroban transaction calls go to local fakes that serve
recorded announcer events and verify each transaction's signatures. Results are
compared with `scripts/python-quickstart/vectors.json`, which
`npm run generate:python-quickstart-vectors` computes from the pinned SDK.

Dependencies are pinned in `scripts/python-quickstart/requirements.txt`. The
`--bootstrap` flag creates a virtualenv with those pins under
`node_modules/.cache`. Every Python fence in the guide must run. A fence that
cannot run needs both words after the language, `python Pseudocode no-check`, so
readers see it is pseudocode.

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

## Preview render and navigation tests

The preview tests build an offline copy of the docs from `docs.json` and the
shipped `.mdx` pages, then drive it with Playwright at desktop and mobile
widths. They visit one page per navigation group, every generated reference
family, and exercise direct load, client navigation, anchor navigation, tab
state and the not-found route.

```bash
npm run build:preview
npm run test:preview
```

The build fails on a nav entry that cannot render, a blank page, a local image
that does not exist, or an internal link that points at no page. The tests fail
on blank pages, console and page errors, missing hydration, missing assets,
broken tab state, unresolved links and anchors, and any request to an external
origin. Failures are reported with the route and navigation group in
`test-results/preview-failures.json` and `test-results/preview-failures.md`.

When you add a page, register it in `docs.json` as usual — the preview picks it
up from the navigation tree. When you add a generator script, add its output
family to `scripts/preview/fixtures.mjs` so the family keeps its render check.

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

## Link checks

`scripts/check-broken-links.mjs` validates routes, anchors, redirects, and shipped
assets. It runs offline, which makes it safe as a required check.

```bash
npm run check:broken-links            # internal only, blocking in CI
npm run check:broken-links:external   # external URLs, advisory
npm run test:broken-links             # checker unit tests
npm run mint:broken-links             # Mintlify CLI, anchors + redirects
```

Internal resolution follows Mintlify, not the file system:

- `/guides/one` and bare `guides/one` resolve from the site root. Bare paths are
  not page-relative.
- Only `./` and `../` resolve relative to the current page.
- Anchors use the ids Mintlify renders, so sentence punctuation becomes a dash
  while symbols are kept: `## Swap + Announce` is `#swap-+-announce`, and
  `## Soroban RPC / Indexer Errors` is `#soroban-rpc-/-indexer-errors`.
- A failing report names both the source page and the target.

External checks are bounded: at most 300 URLs, six concurrent requests, three
attempts with backoff, and a 120 second wall-clock budget. Private, loopback,
link-local, and IPv4-mapped addresses are refused, DNS answers are pinned to the
validated address, and every redirect hop is revalidated. Permanent failures are
reported with their source page but do not fail the required job, because
third-party sites go down without notice. Use `--strict-external` for an opt-in
run that exits non-zero on permanent failures.

## CI

Every pull request runs the snippet checker, the nav coverage check, the contract
registry check, and the internal broken link check through GitHub Actions. The
link check is deterministic and required; external URLs are checked in a
separate advisory job on docs changes and on a weekly schedule, with the JSON
report uploaded as an artifact. A separate non-blocking Stellar testnet job is
reserved for end-to-end snippet validation that depends on network availability.
The workflow also runs extended snippet validation and the redirect and anchor
checks, including their unit tests.

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

### Managed agent examples

The managed-agent workflow builds core 1.4.5 and sdk-agent 0.1.0 from a pinned
SDK commit. To reproduce it with Node 22 and pnpm 10.34.4, run these commands
from the docs root with a fresh SDK checkout:

```sh
git clone https://github.com/wraith-protocol/sdk.git /tmp/wraith-guide-sdk
git -C /tmp/wraith-guide-sdk checkout af34393a7676a11876703a9e5e4ce5381bd08700
pnpm --dir /tmp/wraith-guide-sdk install --frozen-lockfile
pnpm --dir /tmp/wraith-guide-sdk run build
bash scripts/managed-agent/check.sh /tmp/wraith-guide-sdk
```

The check installs both tarballs in a temporary consumer, compiles the
TypeScript fences in the client, single-chain and Stellar cookbook pages,
and runs their request/response fixtures. It needs no platform credentials.
