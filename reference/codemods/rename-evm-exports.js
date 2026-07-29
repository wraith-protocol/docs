/**
 * rename-evm-exports.js
 *
 * jscodeshift codemod — renames all @wraith-protocol/sdk and
 * @wraith-protocol/sdk/chains/* identifiers that changed in v1.0.
 *
 * Handles:
 *   - Named import renames (import { OldName } → import { NewName })
 *   - Named import renames with local aliases preserved
 *     (import { OldName as Alias } stays as import { NewName as Alias })
 *   - Type-only imports (import type { OldType })
 *   - Re-exports (export { OldName } from "...")
 *   - Usages in source only when the local binding name matches the export
 *     name (i.e. no alias was used). When an alias was used, only the
 *     import specifier is rewritten — existing references remain valid.
 *
 * Does NOT handle:
 *   - Dynamic require() calls
 *   - String-based property access (obj["WraithClient"])
 *   - Usages of the removed exports (createClient, deriveKeys, etc.) —
 *     those require manual review per the migration guide.
 *
 * Usage:
 *   npx jscodeshift \
 *     --transform reference/codemods/rename-evm-exports.js \
 *     --extensions ts,tsx,js,jsx \
 *     src/
 *
 * Dry run (no writes):
 *   npx jscodeshift \
 *     --dry \
 *     --transform reference/codemods/rename-evm-exports.js \
 *     --extensions ts,tsx,js,jsx \
 *     src/
 */

"use strict";

// ---------------------------------------------------------------------------
// Rename table: keyed by source package, each entry maps oldName → newName.
// ---------------------------------------------------------------------------
const RENAMES = {
  "@wraith-protocol/sdk": {
    WraithClient: "Wraith",
    WraithAgentClient: "WraithAgent",
    AgentCreateConfig: "AgentConfig",
    WraithClientConfig: "WraithConfig",
    ChainEnum: "Chain",
  },
  "@wraith-protocol/sdk/chains/evm": {
    buildSend: "buildSendStealth",
    buildSendToken: "buildSendERC20",
    buildRegister: "buildRegisterName",
    buildUpdate: "buildUpdateName",
    buildRelease: "buildReleaseName",
    buildResolve: "buildResolveName",
    EvmStealthKeys: "StealthKeys",
    EvmAnnouncement: "Announcement",
    deriveKeys: "deriveStealthKeys",
  },
  "@wraith-protocol/sdk/chains/stellar": {
    signTransaction: "signStellarTransaction",
    StellarStealthKeys: "StealthKeys",
    deriveKeys: "deriveStealthKeys",
  },
  "@wraith-protocol/sdk/chains/solana": {
    signTransaction: "signSolanaTransaction",
    SolanaStealthKeys: "StealthKeys",
    deriveKeys: "deriveStealthKeys",
  },
  "@wraith-protocol/sdk/chains/ckb": {
    CkbStealthKeys: "StealthKeys",
    deriveKeys: "deriveStealthKeys",
  },
};

// ---------------------------------------------------------------------------
// Helper: collect all wraith import/export declarations in this file,
// grouped by source value.
// ---------------------------------------------------------------------------
function collectWraithDeclarations(root, j) {
  const bySource = new Map();

  // import declarations
  root.find(j.ImportDeclaration).forEach((path) => {
    const src = path.node.source.value;
    if (RENAMES[src]) {
      if (!bySource.has(src)) bySource.set(src, []);
      bySource.get(src).push({ path, kind: "import" });
    }
  });

  // export-from declarations (export { Foo } from "...")
  root.find(j.ExportNamedDeclaration).forEach((path) => {
    if (!path.node.source) return;
    const src = path.node.source.value;
    if (RENAMES[src]) {
      if (!bySource.has(src)) bySource.set(src, []);
      bySource.get(src).push({ path, kind: "export" });
    }
  });

  return bySource;
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------
module.exports = function transform(file, api, options) {
  const j = api.jscodeshift;
  const root = j(file.source);
  let dirty = false;

  const declarations = collectWraithDeclarations(root, j);

  declarations.forEach((entries, sourcePkg) => {
    const table = RENAMES[sourcePkg];

    entries.forEach(({ path, kind }) => {
      const specifiers = kind === "import"
        ? path.node.specifiers
        : path.node.specifiers;

      if (!specifiers) return;

      specifiers.forEach((spec) => {
        // For import declarations: spec.imported.name is the export name,
        // spec.local.name is the local binding (may differ if aliased).
        // For export-from: spec.local.name is what's imported, spec.exported.name
        // is what's re-exported. We rename the imported side (spec.local).
        const importedName = kind === "import"
          ? spec.imported && spec.imported.name
          : spec.local && spec.local.name;

        if (!importedName || !table[importedName]) return;

        const newName = table[importedName];
        const localName = kind === "import"
          ? spec.local.name
          : spec.exported.name;
        const isAliased = localName !== importedName;

        // Rewrite the imported identifier
        if (kind === "import") {
          spec.imported.name = newName;
        } else {
          spec.local.name = newName;
        }
        dirty = true;

        // When there's no alias, the local binding is the same as the
        // imported name. Rename every reference to the old identifier in
        // the file scope so it resolves to the new specifier.
        if (!isAliased && kind === "import") {
          root.find(j.Identifier, { name: importedName }).forEach((idPath) => {
            // Skip the specifier node itself (already rewritten above).
            if (idPath.parent.node === spec) return;
            // Skip property keys in member expressions: obj.WraithClient stays.
            if (
              idPath.parent.node.type === "MemberExpression" &&
              idPath.parent.node.property === idPath.node &&
              !idPath.parent.node.computed
            ) {
              return;
            }
            // Skip shorthand object key sides: { WraithClient } key stays.
            if (
              idPath.parent.node.type === "Property" &&
              idPath.parent.node.key === idPath.node &&
              idPath.parent.node.shorthand
            ) {
              // Expand shorthand so both key and value can differ.
              idPath.parent.node.shorthand = false;
              idPath.parent.node.value = j.identifier(importedName);
              // (key will be renamed below on next visit — already queued)
              return;
            }
            idPath.node.name = newName;
          });
        }
      });
    });
  });

  return dirty ? root.toSource({ quote: "double" }) : null;
};

module.exports.parser = "tsx";
