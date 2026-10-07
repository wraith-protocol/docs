# Updating SDK Version in Docs

When updating the `@wraith-protocol/sdk` version in the docs repository, follow these steps:

## Prerequisites

1. Ensure the new SDK version is published to npm
2. Verify the version exists: `npm view @wraith-protocol/sdk versions`

## Update Process

1. Update the version in `package.json`:
   ```json
   "dependencies": {
     "@wraith-protocol/sdk": "X.Y.Z"
   }
   ```

2. Commit the change (the SDK version check workflow will verify the version exists)

3. Update the lockfile:
   ```bash
   pnpm install
   ```

4. Commit the updated lockfile

## CI Behavior

- The `sdk-version-check.yml` workflow runs on any PR that modifies `package.json`
- It verifies the specified SDK version exists on npm before allowing the PR to proceed
- The `snippets.yml` workflow extracts the version from `package.json` and:
  - Downloads the exact published SDK artifact as a `.tgz` file using `npm pack`
  - Installs the packed artifact instead of the registry version
  - Records the tested version in CI output

This ensures docs validation always runs against the exact published SDK version, not local or floating versions.
