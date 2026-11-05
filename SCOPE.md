# Security review scope

Scope is the repository tree at the `security-2026-11-05-v2` release tag. A follow-up review must name its own exact commit and record any changed scope.

- Deployable contracts: `contracts/src/ChanceryRegistry.sol`; generated build records under `contracts/artifacts/`.
- Authentication and API boundary: `server/app.ts`, `server/auth.ts`, `server/config.ts`, `server/errors.ts`, `server/web.ts`.
- Authorization and data: `server/offices.ts`, `server/db.ts`, `server/migrations/`, `server/conversations.ts`, `server/rooms.ts`, `server/crypto.ts`.
- Spending, scheduling and settlement: `server/ledger.ts`, `server/provider.ts`, `server/clerks.ts`, `server/jobs.ts`, `server/reconcile.ts`, `server/collection.ts`, `server/updates.ts`, `server/chain.ts`, `server/bytecode.ts`.
- Deployment verification: `server/deployment.ts`, `scripts/compile-contracts.ts`, `scripts/deployment-payload.ts`, `scripts/verify-deployment.ts`, `Dockerfile`, `foundry.toml`.
- Shared security logic: `shared/`; device encryption and transport in `packages/client/`; signing boundary in `web/wallet.ts`.
- Validation evidence: `tests/`, `contracts/test/`, `security/`, `.github/workflows/ci.yml`, package/toolchain locks and third-party notices.

Presentation/layout code is outside the security score except where it supplies data for signatures or device cryptography. External service internals and any live deployment require separate verification. This scope file does not assert a third-party certification or deployment match.
