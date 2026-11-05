# Chancery security specification

## Reporting

Report vulnerabilities privately to [Chancery@atomicmail.io](mailto:Chancery@atomicmail.io). Include the affected version, a minimal reproduction and the expected impact. Do not include credentials, seed phrases or customer content. Public issues are not a channel for undisclosed vulnerabilities.

## Architecture and boundaries

Chancery connects a browser, an API, a database and a settlement worker. The API authenticates people, checks Office roles and policy, reserves a quoted budget, calls the configured model endpoint, and signs a receipt. The worker submits bounded settlements and anchors. User-controlled treasury wallets authorize governance and retain custody of their assets.

| Component | Data or authority entrusted to it |
| --- | --- |
| Browser and passkey authenticator | User interaction, device keys, wallet confirmation and assertion signing. Room device identities must be reviewed before sharing keys. |
| API host | Ordinary prompt/response plaintext during execution, storage encryption keys, receipt signing keys and provider credentials. |
| Database | Encrypted ordinary content, authorization metadata, quotes, reservations, receipts and transaction outbox. Tenant queries use scoped roles and forced row-level security. |
| Model service | Plaintext deliberately submitted for AI work. Retention eligibility depends on deployment operator review of the external service. |
| Chain RPC | Chain reads and transaction propagation. Runtime and configuration checks constrain accepted infrastructure; RPC availability and truthful chain observations remain dependencies. |
| Settlement contracts | Fixed token and recipient, allowance/cap enforcement, replay rejection and atomic transfer records. They do not hold user deposits. |
| Scheduled Clerks | Text inference under current permissions and limits. No model-executable shell, filesystem or signing tool is exposed. |

## Authorities and holders

Deployment is pre-launch: concrete operator and governance addresses must be supplied through an independently reviewed deployment manifest. No personal holder identities or production infrastructure belong in this repository.

| Holder | Authority | Binding checks |
| --- | --- | --- |
| Administrator multisig | Calls `setOperator`. The administrator is immutable and must be the final governance wallet at construction. | Nonzero replacement, event emission; no contract upgrade path. |
| Each Office treasury's current owners | Open the Office; change seats, policy or cap; create/revoke Clerks; close the Office. | Current owner signatures and wallet threshold/nonce; contract `Safe only` checks and bounded caps. |
| Registered settlement delegates | Call `consume` and `SettlementLog.record` for their own Office/actor. | Registered delegate identity, active state, period and Office cap; duplicate batch rejection. |
| Settlement operator | Calls delegate `settle`, `anchorReceipts` and `anchorMinutes`. | Fixed token/treasury, owner allowances and Office cap, atomic transfer check, replay and period checks. The operator chooses receipt commitments and can bill within those approvals. |
| Deployment maintainers | Configure origin/proxy, database, provider, retention/model lists, optional capabilities and server keys; run billing reconciliation and explicit expired-receipt waivers. | Production config validation, access to the hosting secret store, reconciliation bounded by the original reservation; completed-charge waivers require verified finalized expiry and nonpayment and preserve signed history. |
| Database administrators | Migrate schema and manage database authority. | Operational access controls; separate migration credentials from restricted runtime access. |
| Principal | Current Office wallet owner; proposes, reviews and signs governance; creates/resumes/revokes Clerks; invites team roles. | Current onchain ownership, explicit proposal content, threshold signatures and nonce. |
| Officer | Invites Members/Guests, runs/approves/pauses Clerks, issues Minutes and proposes transaction drafts. | Cannot invite Officers or acquire owner signing authority solely through this role. |
| Member | Uses approved AI within budgets, manages own saved conversations and can create Rooms. | Own response plaintext and own Ledger records; Office/seat limits. |
| Guest | Participates in currently authorized Rooms during the invitation period. | No paid AI work, Ledger/Minutes access or Room creation. |
| Room creator or member-Principal | Manages members and rotates keys while a current Room member. | A Principal outside the Room has no blanket Room-manager access. Every retained device must receive a new key after revocation. |

Officers and Principals can inspect Office receipts; that does not grant another person's stored AI response plaintext through the API. API/hosting administrators remain part of the ordinary-content trust boundary.

## Pre-launch governance handoff

1. Create separate administrator and treasury wallets with at least two distinct owners and a threshold of at least two. Keep owners on separate devices. Use canonical version 1.4.1 wallets without enabled modules, a guard or a fallback handler for these two service wallets. The verifier requires this extension-free policy; custom extensions need a separate security review. End-user Office wallets are distinct from these service wallets. Use the final administrator at deployment: it cannot be transferred later.
2. Designate a separate gas-only settlement operator. It must not be a governance or treasury owner solely to run the worker. Put server encryption/signing/provider credentials in the hosting secret store with restricted operational access.
3. Review the unsigned deployment payload and compiler/source hashes with both governance reviewers. Deployment is a human wallet action.
4. Record confirmed Registry and Log addresses, fixed dependencies, administrator/treasury owner sets and thresholds, operator address, minimum gas balance and artifact hashes in the approved manifest.
5. Run `npm run deployment:verify -- --manifest /private/path/deployment.json`. It must pass before exposing the app. Retain its block number and build hashes with the deployment record.
6. Validate trusted-proxy routing, real database role separation, backups and key recovery. Publish only confirmed public contract addresses and build references when launching; keep operational credentials and internal records private.

## Threat model

Untrusted inputs include user text, model output, HTTP bodies, wallet responses, provider usage, RPC data and package updates. Mutating requests require the configured Origin; authenticated writes also require CSRF. WebAuthn challenges are short-lived, cookie-bound and consumed once. Invalid signatures never mutate a victim credential. Authentication throttling is per client IP and per server process; the deployment must enforce its single trusted proxy hop and add edge-wide rate limits for multi-instance operation.

Ordinary stored content uses authenticated encryption bound to Office and record context. Device-encrypted Rooms use device-held keys and are excluded from inference. Quotes bind model, content, account, actor and maximum cost. Concurrent reservations include uncertain outcomes, so retries cannot silently free disputed spending capacity.

### Protection limits

Chancery does not protect a compromised user device, deceptive content the user chooses to sign, a compromised API host with storage keys, or a malicious database administrator. The client checks transaction identity/hash consistency but structured transaction intent still depends on reviewing backend-produced data. Wallet owners must inspect recipients, amounts, calldata and permissions.

Receipt signatures prove the signer and content integrity, not that a model answered correctly or an operator charged honestly. Anchors prove recorded commitments, not independently measured model usage. External retention statements depend on the configured service. Secret scanning recognizes supported patterns; it is not a guarantee that every possible secret or encoding will be detected.

### Accepted risks

No known Medium or Low implementation finding is accepted as an exception. Operational trust assumptions above are explicit design boundaries, not waivers for defects. New accepted risks require an owner, a concrete reason, compensating controls and a review date before appearing here.

## Security properties and executable evidence

| Property | Test |
| --- | --- |
| Expired uncollected charges recover through signed waivers after finalized nonpayment checks | [period-recovery.test.ts](tests/period-recovery.test.ts): `Collection recovery: expired usage and seat fees can be waived without rewriting signed history`, `Collection recovery: batched charges require finalized nonpayment; failures leave accounting unchanged`, and `Collection proof: expiry and nonpayment use a finalized block and verified contract code` |
| Canonical service multisigs have no unreviewed extension authority | [deployment-fork.test.ts](tests/deployment-fork.test.ts): `Deployment verifier: canonical multisigs on a local fork pass, unexpected extension storage fails` |
| Settlement cannot re-enter even through an authorized contract operator | [ChanceryRegistry.t.sol](contracts/test/ChanceryRegistry.t.sol): `testReentrantOperatorCannotSettleTwice` |
| Challenges are bound, one-use and origin protected | [api.test.ts](tests/api.test.ts): `API: wallet challenge is bound, one-use and origin protected` |
| Cross-Office and unscoped reads/writes are rejected | [api.test.ts](tests/api.test.ts): `database: RLS blocks reads and writes across Offices and unscoped service queries` |
| Real database roles and concurrent reservations agree | [postgres.test.ts](tests/postgres.test.ts): `PostgreSQL: real driver migrations, role isolation and competing budget reservations` |
| Correct WebAuthn verification survives invalid-signature attempts and legacy locks | [passkeys.test.ts](tests/passkeys.test.ts): `Passkeys: complete registration and authentication verify origin, user verification and counter` |
| Excess client authentication requests are throttled | [passkeys.test.ts](tests/passkeys.test.ts): `Passkeys: authentication throttling rejects excess client requests before issuing challenges` |
| Quotes, requests and receipts bind exact content and retries | [billing.test.ts](tests/billing.test.ts): `billing: exact quote, signed receipt, replay and content binding` |
| Concurrent holds remain inside shared budgets | [billing.test.ts](tests/billing.test.ts): `billing: concurrent holds cannot exceed shared Office cap` |
| Unknown outcomes retain holds; explicit refusal releases them | [billing.test.ts](tests/billing.test.ts): `billing: missing cost and network failures retain holds; explicit refusal releases` |
| Charges cannot exceed approved quotes | [billing.test.ts](tests/billing.test.ts): `billing: provider cost above quote is absorbed and zero-retention content is not saved` |
| Amendments preserve earlier receipt evidence | [billing.test.ts](tests/billing.test.ts): `reconciliation: appends a signed amendment and preserves the pending receipt` |
| Clerk approvals are single-use and cannot bypass hard caps | [updates.test.ts](tests/updates.test.ts): `Clerks: approval is content-bound, single-use, and cannot bypass hard caps` |
| Revoked Room devices require key rotation; sealed content cannot enter inference | [updates.test.ts](tests/updates.test.ts): `Rooms: per-device wrapping, authenticated context, and revocation require rotation`; `sealed Rooms refuse inference even for their creator` |
| Integer allocation conserves the exact amount | [primitives.test.ts](tests/primitives.test.ts): `allocation conserves totals, resolves ties and rejects invalid weights` |
| Transfer and settlement record commit atomically | [ChanceryRegistry.t.sol](contracts/test/ChanceryRegistry.t.sol): `testTransferAndLogAreAtomic`, `testFalseTokenTransferRollsBackEverything` |
| All Clerks share the Office cap; closure/revocation stop spending | [ChanceryRegistry.t.sol](contracts/test/ChanceryRegistry.t.sol): `testOfficeCapCoversAllClerks`, `testCloseStopsEveryDelegate`, `testRevokedClerkCannotSettle` |
| Replay, period and caller constraints hold | [ChanceryRegistry.t.sol](contracts/test/ChanceryRegistry.t.sol): `testDuplicateRejected`, `testResetAndStalePeriod`, `testWrongCallerCannotSettle`, `testCannotForgeLogOrBudgetConsumption` |
| Amount conservation holds for fuzzed inputs | [ChanceryRegistry.t.sol](contracts/test/ChanceryRegistry.t.sol): `testFuzzCapConservation` |
| Real token, wallet and allowance contracts support the settlement flow | [MainnetFork.t.sol](contracts/test/MainnetFork.t.sol): `testForkCanonicalAllowanceTransferAndLog`, `testForkResetAndRemoval` |
| Build, authority, multisig and gas mismatches fail deployment verification | [deployment.test.ts](tests/deployment.test.ts): `Deployment verifier: every authority and infrastructure mismatch fails closed`; `Deployment verifier: wrong build, chain, unavailable reads and low gas are rejected` |

These tests document their specific assertions; they do not claim universal route coverage or complete crash/reorganization testing.
