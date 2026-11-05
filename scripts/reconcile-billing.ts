import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { createApp } from "../server/app.ts";
import { hash } from "../server/crypto.ts";
import { reconcileRequest, waiveExpiredReceipt } from "../server/reconcile.ts";
const { values } = parseArgs({
  options: {
    office: { type: "string" },
    request: { type: "string" },
    receipt: { type: "string" },
    "provider-usd": { type: "string" },
    evidence: { type: "string" },
    waive: { type: "boolean", default: false },
  },
});
if (
  !values.office ||
  (!!values.request === !!values.receipt) ||
  (values.request && values["provider-usd"] === undefined) ||
  (values.receipt && !values.waive) ||
  !values.evidence
)
  throw Error(
    "Usage: npm run billing:reconcile -- --office 0xOFFICE --evidence PATH_TO_VERIFIED_RECORD (--request REQUEST_ID --provider-usd ACTUAL_TOTAL [--waive] | --receipt RECEIPT_ID --waive)",
  );
const evidence = await readFile(values.evidence);
if (evidence.length < 1 || evidence.length > 10_000_000)
  throw Error("Billing evidence must be a nonempty file no larger than 10 MB.");
const runtime = await createApp();
try {
  const result = values.receipt ? await waiveExpiredReceipt(runtime, {
    officeId: values.office, receiptId: values.receipt, evidenceHash: hash(evidence),
  }) : await reconcileRequest(runtime, {
    officeId: values.office,
    requestId: values.request!,
    providerUsd: values["provider-usd"]!,
    evidenceHash: hash(evidence),
    waive: values.waive,
  });
  console.log(
    JSON.stringify({
      receiptId: result.id,
      status: "reconciled",
      chargedUsd: result.envelope.payload.chargedUsd,
    }),
  );
} finally {
  await runtime.db.close();
}
