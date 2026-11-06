/** Disposable browser integration fixture. Never imported by the app or shipped in the runtime image. */
import express from "express";
import { fixture, OWNER } from "./fixture.ts";
import { hash, uid } from "../server/crypto.ts";
import { readFile } from "node:fs/promises";
import { simulateChain, TESTER, walletScript } from "./ui-chain.ts";
import { safeTypedTypes } from "../shared/safe-signing.ts";
import { typedSafeMessage } from "../server/chain.ts";
import { createJobs } from "../server/jobs.ts";
import { productivityIds } from "../shared/productivity.ts";
if (process.env.NODE_ENV === "production")
  throw new Error("The browser fixture cannot run in production.");
const runtime = await fixture(
  "rooms,clerks,safe_drafts,minutes,token_benefits,mcp,playbooks,side_by_side,guest_passes,reimbursements,office_files," + productivityIds.join(","),
);
const port = Number(process.env.UI_PORT || 5181);
runtime.cfg.origin = `http://localhost:${port}`;
const { account } = await runtime.login(OWNER);
const office = await runtime.office(account, "250");
await runtime.db.query("UPDATE offices SET name=$1 WHERE id=$2", [
  "Chancery QA · test Office",
  office.id,
]);
runtime.provider.catalog = async () => [
  {
    id: "test-model",
    name: "Protocol fixture · test only",
    contextLength: 100000,
    maxTokens: 8192,
    inputUsdPerMillion: "1",
    outputUsdPerMillion: "2",
    lanes: ["standard"],
  },
  // Extra local-only models so Side by Side has something to compare.
  {
    id: "test-model-fast",
    name: "Fixture Fast · test only",
    contextLength: 32000,
    maxTokens: 4096,
    inputUsdPerMillion: "0.5",
    outputUsdPerMillion: "1",
    lanes: ["standard"],
  },
  {
    id: "test-model-deep",
    name: "Fixture Deep · test only",
    contextLength: 200000,
    maxTokens: 16384,
    inputUsdPerMillion: "3",
    outputUsdPerMillion: "6",
    lanes: ["standard"],
  },
];
const { wallet } = simulateChain(
  runtime.chain,
  runtime.snapshots,
  runtime.cfg.registry as `0x${string}`,
);
// Seed "Test Office" for the test wallet through the real open → sign →
// execute → confirm path, so it's ready on every start.
const tester = (await runtime.login(TESTER as any)).account;
{
  const safe = "0x5afe000000000000000000000000000000000001";
  const opened = await runtime.offices.create(tester, {
    name: "Test Office",
    safe,
    monthlyCap: "250",
  });
  const a = await runtime.offices.access(
    tester,
    opened.officeId,
    undefined,
    true,
  );
  const signature = await TESTER.signTypedData({
    domain: { chainId: 4663, verifyingContract: safe },
    types: safeTypedTypes,
    primaryType: "SafeTx",
    message: typedSafeMessage(opened.proposal.transaction),
  });
  const ready = await runtime.offices.signProposal(
    a,
    opened.proposal.id,
    signature,
  );
  const txHash = await wallet("eth_sendTransaction", [
    { from: TESTER.address, ...ready.execution },
  ]);
  await runtime.offices.confirm(a, opened.proposal.id, txHash as `0x${string}`);
}
function signIn(accountId: string) {
  return async (_req: express.Request, res: express.Response) => {
    const token = uid(),
      csrf = uid();
    await runtime.db.query(
      "INSERT INTO auth_sessions(token_hash,account_id,csrf_hash,expires_at) VALUES($1,$2,$3,$4)",
      [
        hash(token),
        accountId,
        hash(csrf),
        new Date(Date.now() + 12 * 3600000).toISOString(),
      ],
    );
    res.cookie("chancery_session", token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    res.redirect("/app/");
  };
}
const wrapper = express();
// Built-in test wallet: signs with a throwaway fixture key, never a real one.
wrapper.get("/__qa/wallet.js", (_req, res) => {
  res.type("text/javascript").send(walletScript);
});
wrapper.post("/__qa/wallet", express.json(), async (req, res) => {
  try {
    res.json({ result: await wallet(req.body?.method, req.body?.params) });
  } catch (error: any) {
    res
      .status(400)
      .json({ message: error?.message || String(error), code: error?.code });
  }
});
// The worker isn't running here, so charge today's seat fees on demand
// before an Office's paid requests, the way the worker would.
const jobs = createJobs(runtime);
wrapper.post("/api/offices/:id/*rest", async (req, _res, next) => {
  try {
    const [office] = await runtime.db.query(
      "SELECT * FROM offices WHERE id=$1 AND status='active'",
      [req.params.id],
    );
    if (office) await jobs.seatFees(office);
  } catch {}
  next();
});
// Signed out, so you can sign in with the test wallet and open your own Office.
wrapper.get("/__qa/new", (_req, res) => {
  res.clearCookie("chancery_session", { path: "/" });
  res.redirect("/app/");
});
// Ready-made Offices: /__qa/test is yours (test wallet), /__qa is the QA one.
wrapper.get("/__qa/test", signIn(tester.id));
wrapper.get("/__qa", signIn(account.id));
wrapper.get("/app/", async (_req, res) => {
  const source = await readFile("build/app/index.html", "utf8");
  res
    .type("html")
    .send(
      source
        .replace("</head>", '<script src="/__qa/wallet.js"></script></head>')
        .replace(
          "<body>",
          '<body><div style="position:fixed;bottom:0;right:0;z-index:1000;background:#373047;color:#ddd1fa;font:10px Arial;padding:6px 12px;border-radius:6px 0 0 0;pointer-events:none">LOCAL INTEGRATION TEST · no live AI or funds</div>',
        ),
    );
});
wrapper.use(runtime.app);
const server = wrapper.listen(port, "127.0.0.1", (error?: Error) => {
  if (error) {
    console.error(
      `Port ${port} is already in use; the browser fixture may already be running. Set UI_PORT to use another port.`,
    );
    process.exit(1);
  }
  console.log(
    `Browser fixture ready (disposable data only):
  http://localhost:${port}/__qa/test  Test Office, signed in with the test wallet
  http://localhost:${port}/__qa/new   signed out: sign in with the test wallet and open another
  http://localhost:${port}/__qa       the pre-filled QA Office`,
  );
});
process.on("SIGINT", () =>
  server.close(async () => {
    await runtime.db.close();
    process.exit(0);
  }),
);
