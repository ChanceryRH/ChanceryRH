# Chancery changes

## 0.1.1 — 2026-11-05

- Recover expired uncollected usage and seat fees through evidence-backed, finalized-chain-checked waivers that preserve signed history.
- Verify service multisig singleton code and reject unreviewed module, guard or fallback authority.
- Invalid passkey signatures no longer lock another person's credential. Valid assertions also recover credentials locked by an earlier server version.
- Added real-signature regressions, legacy-lock recovery and client authentication-throttle checks.
- Updated the compiler to 0.8.38 and regenerated contract artifacts with explicit build settings.
- Added read-only deployment verification for code, authorities, multisig configuration and operator gas.
- Added pinned build/test/security checks, hashed scanner dependencies and a dependency release cooldown.
- Documented public trust boundaries, authority handoff, test-linked properties and build/deployment procedures.

## 0.1.0

Initial Chancery release snapshot with Office policies, bounded AI requests, signed receipts and owner-approved treasury controls.
