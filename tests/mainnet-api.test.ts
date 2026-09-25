import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createWalletClient,
  http,
  parseAbi,
  encodeFunctionData,
  decodeEventLog,
  keccak256,
  encodeAbiParameters,
  toHex,
  type Hex,
} from "viem";
import { fixture, OWNER, MEMBER, chat } from "./fixture.ts";
import {
  createChain,
  typedSafeMessage,
  safeTypedTypes,
} from "../server/chain.ts";
import { createJobs } from "../server/jobs.ts";
import {
  RHC,
  ADDRESSES,
  ZERO_ADDRESS,
  tokenAbi,
  safeAbi,
} from "../shared/chain.ts";
import { uid } from "../server/crypto.ts";
test(
  "local mainnet fork: API Safe onboarding, owner signature, USDG settlement and receipt anchor",
  { skip: !process.env.LOCAL_FORK_RPC, timeout: 180000 },
  async (t) => {
    const rpc = process.env.LOCAL_FORK_RPC!;
    assert(
      ["localhost", "127.0.0.1"].includes(new URL(rpc).hostname),
      "This test may run only against a local disposable fork.",
    );
    const r = await fixture();
    t.after(() => r.db.close());
    r.cfg.rpc = rpc;
    r.cfg.settlerKey = `0x${"11".repeat(32)}`;
    const chain = createChain(r.cfg);
    Object.assign(r.chain, chain);
    const client = chain.client,
      wallet = createWalletClient({
        chain: RHC,
        transport: http(rpc),
        account: OWNER,
      });
    const rpcCall = (method: string, params: any[]) =>
      client.request({ method, params } as any);
    await rpcCall("anvil_setBalance", [OWNER.address, toHex(10n ** 20n)]);
    const artifact = JSON.parse(
      await readFile(
        new URL(
          "../contracts/artifacts/ChanceryRegistry.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const deployed = await wallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [
        ADDRESSES.usdg,
        MEMBER.address,
        ADDRESSES.allowanceModule,
        OWNER.address,
        OWNER.address,
      ],
    });
    const deployment = await client.waitForTransactionReceipt({
      hash: deployed,
    });
    assert.equal(deployment.status, "success");
    r.cfg.registry = deployment.contractAddress!;
    assert.equal((await chain.configuration()).registry, r.cfg.registry);
    const factoryAbi = parseAbi([
      "function createProxyWithNonce(address singleton,bytes initializer,uint256 saltNonce) returns(address proxy)",
      "event ProxyCreation(address indexed proxy,address singleton)",
    ]);
    const setup = encodeFunctionData({
      abi: parseAbi([
        "function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
      ]),
      functionName: "setup",
      args: [
        [OWNER.address],
        1n,
        ZERO_ADDRESS,
        "0x",
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        0n,
        ZERO_ADDRESS,
      ],
    });
    const created = await wallet.writeContract({
        address: ADDRESSES.safeFactory,
        abi: factoryAbi,
        functionName: "createProxyWithNonce",
        args: [ADDRESSES.safeSingleton, setup, BigInt(Date.now())],
      }),
      receipt = await client.waitForTransactionReceipt({ hash: created });
    const event = receipt.logs
      .flatMap((log) => {
        try {
          return [
            decodeEventLog({
              abi: factoryAbi,
              data: log.data,
              topics: log.topics,
            }),
          ];
        } catch {
          return [];
        }
      })
      .find((e) => e.eventName === "ProxyCreation")!;
    const safe = (event.args as any).proxy;
    assert(safe);
    const user = await r.login(),
      opened = await r.offices.create(user.account, {
        safe,
        name: "Fork Office",
        monthlyCap: "100",
      }),
      a = await r.offices.access(
        user.account,
        opened.officeId,
        undefined,
        true,
      );
    const signature = await OWNER.signTypedData({
      domain: { chainId: 4663, verifyingContract: safe },
      types: safeTypedTypes,
      primaryType: "SafeTx",
      message: typedSafeMessage(opened.proposal.transaction),
    });
    const execution = await r.offices.signProposal(
      a,
      opened.proposal.id,
      signature,
    );
    assert(execution.ready && execution.execution);
    const executed = await wallet.sendTransaction({
      to: safe,
      data: execution.execution.data,
    });
    await client.waitForTransactionReceipt({ hash: executed });
    await rpcCall("evm_mine", []);
    await r.offices.confirm(a, opened.proposal.id, executed);
    const active = await r.offices.access(user.account, opened.officeId);
    assert(active.snapshot?.active);
    // Local storage mutation only: locate the forked ERC20 balance slot without minting live tokens.
    let funded = false;
    for (let slot = 0; slot < 100; slot++) {
      const location = keccak256(
          encodeAbiParameters(
            [{ type: "address" }, { type: "uint256" }],
            [safe, BigInt(slot)],
          ),
        ),
        previous = await client.getStorageAt({
          address: ADDRESSES.usdg,
          slot: location,
        });
      await rpcCall("anvil_setStorageAt", [
        ADDRESSES.usdg,
        location,
        toHex(1000000000n, { size: 32 }),
      ]);
      if (
        (await client.readContract({
          address: ADDRESSES.usdg,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [safe],
        })) === 1000000000n
      ) {
        funded = true;
        break;
      }
      await rpcCall("anvil_setStorageAt", [
        ADDRESSES.usdg,
        location,
        previous || toHex(0n, { size: 32 }),
      ]);
    }
    assert(funded, "USDG balance slot not found on the local fork");
    const jobs = createJobs(r);
    await jobs.seatFees(active.office);
    const [fees] = await r.db.office(opened.officeId, (q) =>
      q.query(
        "SELECT sum(charged_pico)::text AS amount FROM receipts WHERE kind='seat_fee'",
      ),
    );
    const feeUnits = BigInt(fees.amount) / 1000000n;
    const quote = await r.ledger.quote(active, chat),
      result = await r.ledger.request(active, {
        id: uid("request_"),
        quoteId: quote.id,
        chat,
      });
    assert.equal(result.status, "complete");
    await r.db.office(opened.officeId, (q) =>
      q.query("UPDATE receipts SET created_at=now()-interval '1 day'"),
    );
    const before = await client.readContract({
      address: ADDRESSES.usdg,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [MEMBER.address],
    });
    await jobs.settle(active.office);
    await rpcCall("evm_mine", []);
    await jobs.outbox();
    const after = await client.readContract({
      address: ADDRESSES.usdg,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [MEMBER.address],
    });
    assert.equal(after - before, feeUnits + 10500n);
    const [batch] = await r.db.office(opened.officeId, (q) =>
      q.query("SELECT * FROM settlements"),
    );
    assert.equal(batch.status, "confirmed");
    await jobs.settle(active.office);
    assert.equal(
      (
        await r.db.office(opened.officeId, (q) =>
          q.query("SELECT * FROM settlements"),
        )
      ).length,
      1,
    );
    r.cfg.released.add("clerks");
    const clerk = await r.clerks.create(active, {
      name: "Fork Clerk",
      job: "Summarize tasks",
      model: "test-model",
      monthlyCap: "10",
      rulebook: {
        models: ["test-model"],
        perRequestUsd: "1",
        perHourUsd: "2",
        perDayUsd: "5",
        perWeekUsd: "10",
        askAboveUsd: "1",
        maxTokens: 100,
      },
    });
    const clerkSignature = await OWNER.signTypedData({
      domain: { chainId: 4663, verifyingContract: safe },
      types: safeTypedTypes,
      primaryType: "SafeTx",
      message: typedSafeMessage(clerk.proposal.transaction),
    });
    const clerkExecution = await r.offices.signProposal(
      active,
      clerk.proposal.id,
      clerkSignature,
    );
    assert(clerkExecution.execution);
    const clerkTx = await wallet.sendTransaction({
      to: safe,
      data: clerkExecution.execution.data,
    });
    await client.waitForTransactionReceipt({ hash: clerkTx });
    await rpcCall("evm_mine", []);
    await r.offices.confirm(active, clerk.proposal.id, clerkTx);
    const clerkQuote = await r.clerks.prepare(active, clerk.id, chat),
      clerkResult = await r.clerks.run(active, clerk.id, {
        id: uid("request_"),
        quoteId: clerkQuote.quote.id,
        chat,
      });
    assert.equal(clerkResult.status, "complete");
    await r.db.office(opened.officeId, (q) =>
      q.query(
        "UPDATE receipts SET created_at=now()-interval '25 hours' WHERE id=$1",
        [clerkResult.receipt.payload.id],
      ),
    );
    await jobs.settle(active.office);
    await rpcCall("evm_mine", []);
    await jobs.outbox();
    const total = await client.readContract({
      address: ADDRESSES.usdg,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [MEMBER.address],
    });
    assert.equal(total - before, feeUnits + 21000n);
    await jobs.anchors(active.office);
    await rpcCall("evm_mine", []);
    await jobs.outbox();
    await jobs.anchors(active.office);
    await rpcCall("evm_mine", []);
    await jobs.outbox();
    const proof = await r.ledger.proof(active, result.receipt.payload.id);
    assert.equal(proof.anchor?.status, "confirmed");
    assert.equal(proof.settlement?.status, "confirmed");
    assert(await r.crypto.verify(proof.envelope));
  },
);
