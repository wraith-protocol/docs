#!/usr/bin/env bash
set -euo pipefail

# Accept a built SDK checkout. Keep the consumer outside both workspaces so
# workspace links, source aliases and ambient types cannot satisfy an import.
sdk=$(cd "${1:?usage: check.sh <built SDK checkout>}" && pwd)
consumer=$(mktemp -d)
trap 'rm -rf "$consumer"' EXIT
pnpm --dir "$sdk" pack --pack-destination "$consumer"
pnpm --dir "$sdk/packages/sdk-agent" pack --pack-destination "$consumer"
cat > "$consumer/package.json" <<'JSON'
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@wraith-protocol/sdk": "file:wraith-protocol-sdk-1.4.5.tgz",
    "@wraith-protocol/sdk-agent": "file:wraith-protocol-sdk-agent-0.1.0.tgz",
    "@stellar/stellar-sdk": "13.3.0",
    "@types/node": "22.20.1",
    "typescript": "5.9.3"
  },
  "pnpm": {
    "overrides": {
      "@wraith-protocol/sdk": "file:wraith-protocol-sdk-1.4.5.tgz"
    }
  }
}
JSON
pnpm --dir "$consumer" install --ignore-scripts --no-frozen-lockfile
node scripts/managed-agent/check.mjs "$consumer"
