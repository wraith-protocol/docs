# Codemods

Automated transforms for migrating from `@wraith-protocol/sdk` 0.x to 1.0. All transforms use [jscodeshift](https://github.com/facebook/jscodeshift) and work on TypeScript and JavaScript source files.

See the [Migrating to v1](/reference/migrating-to-v1) guide for the full list of breaking changes, removed exports, and behavioral changes that require manual review.

---

## Prerequisites

```bash
npm install --save-dev jscodeshift
# or run directly with npx (no install needed)
```

---

## Available transforms

### `rename-evm-exports.js`

Renames all identifiers across every `@wraith-protocol/sdk` package that changed in v1.0. Covers:

| Package | Changes |
|---|---|
| `@wraith-protocol/sdk` | `WraithClient` → `Wraith`, `WraithAgentClient` → `WraithAgent`, `AgentCreateConfig` → `AgentConfig`, `WraithClientConfig` → `WraithConfig`, `ChainEnum` → `Chain` |
| `@wraith-protocol/sdk/chains/evm` | `buildSend` → `buildSendStealth`, `buildSendToken` → `buildSendERC20`, `buildRegister` → `buildRegisterName`, `buildUpdate` → `buildUpdateName`, `buildRelease` → `buildReleaseName`, `buildResolve` → `buildResolveName`, `EvmStealthKeys` → `StealthKeys`, `EvmAnnouncement` → `Announcement`, `deriveKeys` → `deriveStealthKeys` |
| `@wraith-protocol/sdk/chains/stellar` | `signTransaction` → `signStellarTransaction`, `StellarStealthKeys` → `StealthKeys`, `deriveKeys` → `deriveStealthKeys` |
| `@wraith-protocol/sdk/chains/solana` | `signTransaction` → `signSolanaTransaction`, `SolanaStealthKeys` → `StealthKeys`, `deriveKeys` → `deriveStealthKeys` |
| `@wraith-protocol/sdk/chains/ckb` | `CkbStealthKeys` → `StealthKeys`, `deriveKeys` → `deriveStealthKeys` |

#### Usage

```bash
# Dry run — print what would change without writing any files
npx jscodeshift \
  --dry \
  --print \
  --transform reference/codemods/rename-evm-exports.js \
  --extensions ts,tsx,js,jsx \
  src/

# Apply changes
npx jscodeshift \
  --transform reference/codemods/rename-evm-exports.js \
  --extensions ts,tsx,js,jsx \
  src/
```

Target a single file:

```bash
npx jscodeshift \
  --transform reference/codemods/rename-evm-exports.js \
  src/payments/stealth.ts
```

#### What it handles

- Named import renames: `import { WraithClient }` → `import { Wraith }`
- Local alias preservation: `import { WraithClient as WC }` → `import { Wraith as WC }` (usages of `WC` are untouched)
- All usages in scope when no alias is used: every `WraithClient` reference → `Wraith`
- Type-only imports: `import type { EvmStealthKeys }` → `import type { StealthKeys }`
- Re-exports: `export { buildSend } from "@wraith-protocol/sdk/chains/evm"` → `export { buildSendStealth } from ...`

#### What it does NOT handle

- `createClient` — removed without replacement (see [migration guide](/reference/migrating-to-v1#createclientconfig-root-package))
- `CHAIN_IDS` — replaced by `getDeployment(chain).chainId` (requires manual edit)
- `computeEphemeralKey` — internal helper, remove and rely on `generateStealthAddress` default behaviour
- Dynamic `require()` calls
- String-based property access: `obj["WraithClient"]`

Run the dry run first, review the diff, then apply.

---

## After running the codemod

1. **Check TypeScript errors.** Run `tsc --noEmit` to catch anything the transform missed.
2. **Handle removed exports manually.** See [removed exports](/reference/migrating-to-v1#removed-exports) in the migration guide.
3. **Fix the `scanAnnouncements` fourth argument** for Stellar and Solana — change `keys.spendingKey` to `keys.spendingScalar`. The codemod does not touch runtime argument values.
4. **Update `@stellar/stellar-sdk` memo API** if you attach memos to Stellar transactions. See [behavioral changes](/reference/migrating-to-v1#behavioral-changes) in the migration guide.

---

## Contributing a codemod

Add new transforms to this directory. Each transform must:

1. Export a `module.exports = function transform(file, api, options) { ... }` function
2. Export `module.exports.parser = "tsx"` so TypeScript source is parsed correctly
3. Return `null` when no changes were made (prevents jscodeshift from marking files as modified)
4. Include a JSDoc comment block at the top listing what it handles and what it does not handle
5. Be named after the migration it performs: `rename-<what>.js`, `remove-<what>.js`, `migrate-<what>.js`
