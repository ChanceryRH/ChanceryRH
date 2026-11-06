# Build and operate Chancery


## AI connections (MCP)

Enable the `mcp` release after applying migration 010. Append `mcp` to the existing `RELEASED_UPDATES` list. Removing it disables MCP access. No contract change or signing key is needed.

Open **Settings → AI connections**. Sign in recently, choose permissions and a 1–30 day expiry, and create a connection. Copy the one-time token to your client's protected credential configuration. Each token belongs to one account and one Office. An Office owner may revoke any connection. Revocation cancels pending work; work already approved may finish.

The remote endpoint is `https://<your-app-host>/mcp`, using Streamable HTTP and `Authorization: Bearer <connection-token>`. The proxy must preserve the configured application's Host header. Cookie sessions are not MCP credentials. URL credentials, foreign Origins, JSON-RPC batches and oversized requests are rejected. This release uses manually provisioned tokens, not OAuth discovery or automatic browser authorization.

For local stdio clients, run `node --import tsx scripts/mcp-bridge.ts` with the repository as the working directory, or configure absolute paths. Provide `CHANCERY_MCP_URL` and `CHANCERY_MCP_TOKEN` through the client's secret store or private environment configuration. Never commit that configuration. The bridge accepts HTTPS (or loopback HTTP for local development), refuses redirects, and keeps protocol stdout free of diagnostics and secrets.

| Permission | Tools |
| --- | --- |
| Office overview | `get_office` |
| Model choices | `list_models` |
| Your conversations | `list_conversations`, `read_conversation` |
| Spending and receipts | `list_receipts`, `get_receipt_proof` |
| Clerk status | `list_clerks` (requires Clerks and owner/officer access) |
| Prepare AI work | `prepare_ai_request`, `get_ai_request` |

Conversation access is limited to your own history. Ledger access uses your existing Office role. Sealed Room keys and ciphertext are not exposed. Returned text is untrusted content; clients must not treat it as instructions.

`prepare_ai_request` accepts a model, prompt, output-token limit, and stable `clientRequestId`. It stores an encrypted request with a 24-hour approval window; it does not run inference or spend. In Settings, review the exact prompt, get a fresh price and approve. Browser approval uses the existing signed quote, budget checks, idempotent execution and receipt path. Standard retention is required so the request can be reviewed and its result returned to the originating connection. Another connection cannot retrieve that result.

Credentials are hashed, checked on each request, and invalidated by expiry, revocation or a changed Office role. Tools recheck current Office access. Database-backed limits apply across API processes. Audit events contain tool names and identifiers, never tokens, prompts, responses or client IPs. Existing encrypted-storage backup and retention procedures apply to draft records.

Run `node --import tsx --test tests/mcp.test.ts` for official SDK HTTP and stdio clients, isolation, expiry, revocation, CSRF, limits and the approval boundary.


## Fresh clone

Use Node 24.22.1 (`.nvmrc`) and npm 11.19.1. Dependency installation disables lifecycle scripts and applies a seven-day release cooldown. Keep the lockfile; investigate blocked updates rather than deleting it.

```sh
git clone https://github.com/ChanceryRH/ChanceryRH.git
cd ChanceryRH
nvm install
npm install --global npm@11.19.1 --ignore-scripts
npm ci --ignore-scripts
cp .env.example .env
npm run build
npm test
npm run test:coverage
node_modules/.bin/forge test --no-match-path 'contracts/test/MainnetFork.t.sol'
npm run dev
```

The development API listens on port 3080 and the development app on 5180. Local database storage is under `.local/`. Configure the provider endpoint/key and model access for AI requests. Without a deployed Registry and operator configuration, the app reports the relevant readiness checks as unavailable. Optional capabilities are described in the roadmap and have validated dependencies in `shared/releases.ts`.

## Integration checks

Use an empty disposable PostgreSQL database whose migration user can create the application's roles. The suite creates/migrates test data; never point it at customer data.

```sh
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/chancery_test npm test
RHC_FORK=true node_modules/.bin/forge test --match-path 'contracts/test/MainnetFork.t.sol'
```

The fork reads the configured public chain RPC and executes writes only in the local test VM. The optional API integration test accepts only a loopback `LOCAL_FORK_RPC` endpoint. Start a disposable local fork and set that variable to exercise wallet onboarding through settlement and anchoring.

## Reproducible build

The deployable Solidity source, npm compiler and Foundry compiler are pinned to 0.8.38. Both builds use optimized IR, 200 optimizer runs, Cancun and metadata bytecode hashing disabled. `npm run contracts:compile` regenerates the three committed artifacts. CI rejects a difference after regeneration. Node and container content are pinned, and CI uses full action revisions. Scanner dependencies are versioned with hashes in `security/scanners.lock`.

Compiler upgrades can change deterministic delegate addresses. Treat regenerated artifacts as a new build: compare behavior and address derivation, rerun fork tests, and verify each deployed instance against its original approved build. Never silently point an existing installation at a different build of record.

## Deployment

1. Follow the final multisig/authority handoff in [SECURITY.md](SECURITY.md). Review an unsigned Registry payload with the final public administrator, treasury and gas-only operator addresses:

   ```sh
   npm run deployment:payload -- --admin "$ADMINISTRATOR" --treasury "$TREASURY" --operator "$OPERATOR" --out /private/path/unsigned-deployment.json
   ```

2. The designated wallet owners review and submit deployment themselves. Record the confirmed Registry and settlement-log addresses. Never commit private keys or deployment secrets.
3. Copy `deployment.example.json` outside the repository, replace every placeholder and record the exact SHA-256 hashes of the source and artifact files. Enter the expected administrator/treasury owner sets and thresholds from the independently approved governance record. Do not populate expected fields by blindly trusting the target being checked.

   ```sh
   shasum -a 256 contracts/src/ChanceryRegistry.sol contracts/artifacts/ChanceryRegistry.json contracts/artifacts/SettlementLog.json
   npm run deployment:verify -- --manifest /private/path/deployment.json
   ```

   The verifier reads at one block, verifies runtime plus immutable values, checks the log's Registry backlink, verifies the canonical multisig singleton and both proxies/owner sets/thresholds, requires no modules/guard/fallback handler in service wallets, and checks minimum operator gas. Set `extensions` to `none` in both service-wallet manifest sections after independently confirming that policy. It exits nonzero on mismatch or failed reads, and never signs or broadcasts.
4. Supply production configuration through the host's secret store: HTTPS `APP_ORIGIN`, PostgreSQL `DATABASE_URL`, persistent storage and receipt-signing keys, provider settings, confirmed Registry address and gas-only operator key. `npm run secrets:generate` generates server keys for secure storage; keep its output private. Use a separate migration credential through `MIGRATION_DATABASE_URL`.
5. Build the pinned Dockerfile. Run `npm run db:migrate` with the migration credential, then the API (`npm start`) and a separate worker (`npm run worker`). Run as the image's non-root user. Configure exactly one trusted reverse proxy and block direct access to the application port. Use HTTPS, encrypted backups and reviewed recovery access.
6. Check `/health` and require `/ready` to return success. A successful health response alone does not establish database, operator or worker readiness. Require deployment verification and application/database/fork CI checks before launch.

## Operations

Retain the approved manifest, build hashes and verifier output privately. Re-run verification after any operational change and before accepting a redeployment. Monitor worker readiness, operator gas, Registry operator-change/Office-close events and settlement amounts relative to approved limits. A failed verification is a deployment stop, not permission to rewrite the expected manifest.

If a settlement credential is compromised, stop the worker and have the administrator multisig rotate the operator; Office owners can revoke allowances or close an Office. Assets remain under their wallet control. If storage keys are exposed, isolate the API, rotate keys through a tested re-encryption/recovery procedure and assess stored-content exposure. Preserve evidence privately and involve the designated deployment incident owner. Production launch requires a staffed incident contact and tested backup recovery.

### Recover an expired allowance period

If new spending returns `previous_period_unsettled`, inspect the old receipts and the worker outbox. Resolve uncertain requests with the existing evidence-backed request reconciliation command. A completed charge or seat fee that missed its collection period has an explicit operator waiver path:

```sh
npm run billing:reconcile -- --office "$OFFICE_ID" --receipt "$RECEIPT_ID" --waive --evidence /private/path/recovery-record.json
```

Run this only through the restricted operational environment. Record the incident, original receipt and reason in the private evidence file. The command verifies the Registry and Log build, reads one finalized block, requires the original allowance period to have expired, and rejects a batch already recorded as paid. Failed or unavailable finality checks leave accounting unchanged. For a paid batch missing local confirmation, reconcile the outbox; do not waive it.

A successful waiver preserves the original signed envelope, Merkle leaf and batch/anchor links, and appends a signed zero-cost amendment with its proof block and evidence hash. It clears only that receipt's uncollectible balance. Repeat for each eligible old charge; never edit database amounts or move old charges into a new allowance period. Pending signed transactions retain their exact outbox entry and nonce until ordinary receipt processing resolves them; after finalized expiry their old-period debit cannot succeed. Recovery is explicit, never an automatic write-off.

## Public checks

`Chancery checks` builds, tests with a real PostgreSQL service, exercises chain dependencies in a local fork, checks package advisories, scans full Git history and runs static analysis. Static rules are local and telemetry is disabled. The scanners' findings need review; a passing check is not a promise that every defect is detectable.

Third-party licenses and exact vendored revisions are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
