# FOLO compatibility contracts

This package freezes the client/backend boundary used by the self-hosted implementation. It is
deliberately independent of the future backend so the frontend and backend can validate the same
contract.

## Commands

```bash
# Verify that production API usage, capability policy, fixtures, SDK, and local schema are frozen.
pnpm contracts:check

# Regenerate the static production API inventory after intentionally changing client usage.
pnpm contracts:update
pnpm contracts:check
```

`contracts:update` only updates `contracts/api-usage.generated.json`. If a new route appears, the
tests still fail until the route is assigned exactly once in `contracts/capabilities.json`. This is
intentional: adding a frontend API call must be paired with an explicit backend or hidden-feature
decision.

## Contract files

- `stage-0-baseline.json`: verified client, SDK, toolchain, upstream commit, and local SQLite schema.
- `api-usage.generated.json`: SDK route metadata, non-SDK requests, and every production callsite.
- `capabilities.json`: implementation stage, provider, and client behavior for every used route.
- `fixtures/`: minimal canonical success, error, and NDJSON stream shapes.

The SQLite schema is frozen as a rebuildable client projection. It is not the authoritative backend
schema. A schema change or SDK upgrade requires an explicit baseline update after contract and
regression tests pass.
