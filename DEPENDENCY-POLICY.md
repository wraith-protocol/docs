# Dependency advisory policy — docs tooling

The documentation in this repository is built and verified by executable
tooling: the TypeScript snippet compiler, the interactive playground and its
Playwright smoke tests, the Python and Rust quickstart harnesses, and the
`@wraith-protocol/sdk` chain SDKs they load. Those packages are declared as
production dependencies because the checks run against them exactly as a reader
would consume them, so they are a supply-chain surface that is held to the same
bar as shipped code.

## Requirements

- **No high or critical advisories** on any production dependency path. This is
  enforced by the [`Dependency audit`](https://github.com/wraith-protocol/docs/blob/develop/.github/workflows/dependency-audit.yml)
  workflow, which runs `pnpm audit --prod --audit-level high` on every pull
  request, on every push to `develop` and `main`, and weekly against the live
  advisory database. A high or critical finding blocks merge until the
  dependency is upgraded or the vulnerable path is removed. Do not waive it.
- **Moderate and low findings** are reviewed case by case. A finding may be
  recorded in `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml` only when both of
  the following hold:
  1. no patched release exists that is compatible with the pinned parent ranges
     and the SDK's declared peer dependencies, and
  2. the vulnerable code path is not reachable from the docs tooling.

  Every entry must be justified in the pull request that adds it. Remove the
  entry as soon as the parent dependency ships a compatible fix.
- **Fixes prefer upgrades.** `pnpm.overrides` is used only to lift a transitive
  dependency to a patched version when its parent has not released one. An
  override is a temporary bridge: drop it once the parent resolves the fix on
  its own.

## Accepted findings

| Advisory | Package | Path | Why it is accepted |
|---|---|---|---|
| [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x) | `stream-json` | `@solana/web3.js` → `jayson` | Patched releases (`>=3.6.0`) are ESM-only and no longer expose the `stream-json/streamers/StreamValues` and `stream-json/utils/Verifier` subpaths that `jayson@4` `require()`s, so there is no compatible fix. Affects the filter operators, which `jayson` does not use. |
| [GHSA-hqr4-qq8f-hg3x](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x) | `stream-json` | `@solana/web3.js` → `jayson` | Same compatibility constraint as above. Affects the JSONC parser and verifier, which `jayson` does not use. |
| [GHSA-mjw6-4jj6-33hc](https://github.com/advisories/GHSA-mjw6-4jj6-33hc) | `stream-json` | `@solana/web3.js` → `jayson` | Same compatibility constraint as above. Affects the `Assembler` convenience stream, which `jayson` does not use. |

The high-severity Stellar path findings (`axios`, `follow-redirects`, `toml`) and the Solana path
`uuid` finding are fixed by the `overrides` entries in `pnpm-workspace.yaml`; see
the pull request that added them for the resolution details.

## Running the check locally

```bash
pnpm install --frozen-lockfile
pnpm audit --prod --audit-level high
```
