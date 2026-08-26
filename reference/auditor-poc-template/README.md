# Wraith Protocol — Security PoC Template

Minimal, self-contained starting point for a Wraith Protocol vulnerability proof of concept.

## Layout

```
security-poc-template/
├── README.md          # This file: summary, environment, run steps
├── repro.ts           # Minimal reproduction script
└── EXPECTED_OUTPUT.md # What a successful repro prints / on-chain state
```

## Affected component

> Fill this in. Name the contract, script, or SDK module and the version or commit hash.
> Cite the relevant threat-model ID(s) from `/reference/threat-model`
> (e.g. `E-15`, `S-11`, `R-01`).

## Environment

- Chain: _(EVM / Stellar / Solana / CKB)_
- Network: _(testnet recommended)_
- SDK: `@wraith-protocol/sdk` version _(x.y.z)_
- Node: _(version)_

## Run

```bash
pnpm install
export WRAITH_API_KEY=...
pnpm tsx repro.ts
```

Then compare console output against `EXPECTED_OUTPUT.md`.
