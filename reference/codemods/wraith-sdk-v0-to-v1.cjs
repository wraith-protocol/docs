"use strict";

/**
 * jscodeshift transform: Wraith SDK v0.x → v1.x
 *
 * Handles all public symbol renames from the v1 API-stability sweep (issue #6).
 *
 * Transforms applied:
 *   - Import renames: ChainEnum → Chain, WraithClientConfig → WraithConfig,
 *                     CreateAgentOptions → AgentConfig
 *   - Method call renames: agent.sendMessage() → agent.chat()
 *                          agent.payments() → agent.scanPayments()
 *                          agent.balance() → agent.getBalance()
 *                          agent.conversations() → agent.getConversations()
 *                          agent.messages() → agent.getMessages()
 *   - Method call renames + await removal: wraith.getAgent() → wraith.agent()
 *
 * Usage:
 *   npx jscodeshift \
 *     --transform reference/codemods/wraith-sdk-v0-to-v1.cjs \
 *     --extensions ts,tsx,js,jsx \
 *     src/
 *
 * The transform is idempotent — running it twice produces the same result.
 *
 * Limitations:
 *   - Dynamic property access (`agent["sendMessage"]`) is not transformed.
 *   - If your variable holding a WraithAgent is not named `agent`, the method
 *     renames still apply because this transform rewrites ALL calls matching
 *     the old method name on ANY object. Review the diff carefully.
 *   - The `await wraith.getAgent()` removal only strips `await` when the call
 *     is directly awaited (i.e., `await wraith.getAgent(id)`). If you stored
 *     the promise and awaited it separately, update that manually.
 */

const IMPORT_RENAMES = {
  ChainEnum: "Chain",
  WraithClientConfig: "WraithConfig",
  CreateAgentOptions: "AgentConfig",
};

/** Method renames applied to any object. */
const METHOD_RENAMES = {
  sendMessage: "chat",
  payments: "scanPayments",
  balance: "getBalance",
  conversations: "getConversations",
  messages: "getMessages",
};

/** Methods that should also have `await` stripped from the call expression. */
const SYNC_METHODS = new Set(["getAgent"]);
const SYNC_METHOD_RENAMES = {
  getAgent: "agent",
};

/**
 * @param {import("jscodeshift").FileInfo} file
 * @param {import("jscodeshift").API} api
 * @returns {string}
 */
module.exports = function transform(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);
  let changed = false;

  // ─── 1. Rename imported specifiers ───────────────────────────────────────
  root
    .find(j.ImportDeclaration, { source: { value: "@wraith-protocol/sdk" } })
    .forEach((importDecl) => {
      importDecl.node.specifiers.forEach((specifier) => {
        if (
          specifier.type === "ImportSpecifier" &&
          IMPORT_RENAMES[specifier.imported.name]
        ) {
          const oldName = specifier.imported.name;
          const newName = IMPORT_RENAMES[oldName];

          // Rename the imported binding in all usages throughout the file.
          root
            .find(j.Identifier, { name: oldName })
            .forEach((identPath) => {
              // Skip the import declaration itself — we handle it below.
              if (
                identPath.parent.node.type === "ImportSpecifier" &&
                identPath.parent.node.imported === identPath.node
              ) {
                return;
              }
              identPath.node.name = newName;
              changed = true;
            });

          // Rename the import specifier and its local alias if they match.
          if (specifier.local.name === oldName) {
            specifier.local.name = newName;
          }
          specifier.imported.name = newName;
          changed = true;
        }
      });
    });

  // ─── 2. Rename method calls ───────────────────────────────────────────────
  root.find(j.CallExpression).forEach((callPath) => {
    const callee = callPath.node.callee;

    if (callee.type !== "MemberExpression") return;
    if (callee.computed) return; // skip obj["method"]() — dynamic access
    if (callee.property.type !== "Identifier") return;

    const methodName = callee.property.name;

    // Ordinary method renames (no await removal).
    if (METHOD_RENAMES[methodName]) {
      callee.property.name = METHOD_RENAMES[methodName];
      changed = true;
      return;
    }

    // Methods that become synchronous: rename + strip surrounding await.
    if (SYNC_METHODS.has(methodName)) {
      callee.property.name = SYNC_METHOD_RENAMES[methodName];
      changed = true;

      // Strip `await` if this call is the direct operand of an AwaitExpression.
      const parent = callPath.parent;
      if (parent && parent.node.type === "AwaitExpression") {
        // Replace the AwaitExpression with the unwrapped CallExpression.
        j(parent).replaceWith(callPath.node);
      }
    }
  });

  return changed ? root.toSource({ quote: "double" }) : file.source;
};
