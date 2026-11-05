/** Browser fixture only: a pretend Robinhood Chain and a built-in test wallet,
 *  so a tester can open an Office from scratch on localhost. Never imported by
 *  the app or shipped in the runtime image. No real chain, keys or funds. */
import {
  concat,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbi,
  recoverAddress,
  recoverTypedDataAddress,
  slice,
  hexToBigInt,
  hexToNumber,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import {
  ADDRESSES,
  ZERO,
  allowanceAbi,
  registryAbi,
  safeAbi,
  type SafeTransaction,
} from "../shared/chain.ts";
import { encodeSafeExecution, safeTypedTypes } from "../shared/safe-signing.ts";
import {
  officeIdFor,
  typedSafeMessage,
  type OfficeSnapshot,
} from "../server/chain.ts";

/** Well-known throwaway key used only by this local fixture. */
export const TESTER = privateKeyToAccount(`0x${"33".repeat(32)}`);
const multiSendAbi = parseAbi(["function multiSend(bytes transactions)"]);
const lower = (a: string) => a.toLowerCase() as Address;
const decode = (abi: any, data: Hex): any => {
  try {
    return decodeFunctionData({ abi, data });
  } catch {
    return null; // Calls the simulation doesn't model are accepted as no-ops.
  }
};

type SafeState = {
  owners: Address[];
  threshold: number;
  nonce: bigint;
  moduleEnabled: boolean;
};
type OfficeState = Omit<
  OfficeSnapshot,
  | "owners"
  | "threshold"
  | "moduleEnabled"
  | "block"
  | "delegate"
  | "actorActive"
> & { clerks: Set<string> };

export function simulateChain(
  chain: any,
  snapshots: Map<string, OfficeSnapshot>,
  registry: Address,
) {
  const fixtureSafes = new Set(
    [...snapshots.values()].map((s) => lower(s.safe)),
  );
  const original = {
    safe: chain.safe,
    snapshot: chain.snapshot,
    delegateFor: chain.delegateFor,
    prepare: chain.prepare,
  };
  const safes = new Map<Address, SafeState>(),
    offices = new Map<string, OfficeState>(),
    allowances = new Map<Address, bigint>(),
    executed = new Map<string, { safe: Address; safeTxHash: Hex }>();

  const safeState = (address: Address) => {
    const key = lower(address);
    let s = safes.get(key);
    if (!s) {
      s = {
        owners: [lower(TESTER.address)],
        threshold: 1,
        nonce: 0n,
        moduleEnabled: false,
      };
      safes.set(key, s);
    }
    return s;
  };
  const delegate = (safe: Address, actorId: Hex = ZERO) =>
    getAddress(slice(keccak256(concat([lower(safe), actorId])), 12));
  const hashOf = (safe: Address, tx: SafeTransaction) =>
    hashTypedData({
      domain: { chainId: 4663, verifyingContract: safe },
      types: safeTypedTypes,
      primaryType: "SafeTx",
      message: typedSafeMessage(tx),
    });

  chain.safe = async (address: Address) => {
    if (fixtureSafes.has(lower(address))) return original.safe(address);
    const s = safeState(address);
    return {
      address,
      owners: [...s.owners],
      threshold: s.threshold,
      nonce: s.nonce.toString(),
      block: "100",
      moduleEnabled: s.moduleEnabled,
    };
  };
  chain.delegateFor = async (safe: Address, actorId: Hex = ZERO) =>
    fixtureSafes.has(lower(safe))
      ? original.delegateFor(safe, actorId)
      : delegate(safe, actorId);
  chain.snapshot = async (id: string, actorId: Hex = ZERO) => {
    const o = offices.get(id);
    if (!o) return original.snapshot(id, actorId);
    const s = safeState(o.safe),
      d = delegate(o.safe, actorId);
    return {
      ...o,
      clerks: undefined,
      delegate: d,
      actorActive: actorId === ZERO || o.clerks.has(actorId.toLowerCase()),
      allowanceUnits: allowances.get(lower(d)) ?? 0n,
      owners: [...s.owners],
      threshold: s.threshold,
      moduleEnabled: s.moduleEnabled,
      block: "100",
    };
  };
  chain.prepare = async (
    safe: Address,
    calls: { to: Address; data: Hex; value?: string }[],
  ) => {
    if (fixtureSafes.has(lower(safe))) return original.prepare(safe, calls);
    const info = await chain.safe(safe);
    const packed = concat(
      calls.map((c) => {
        const data = c.data.slice(2);
        return concat([
          "0x00",
          lower(c.to),
          `0x${BigInt(c.value || "0")
            .toString(16)
            .padStart(64, "0")}`,
          `0x${(data.length / 2).toString(16).padStart(64, "0")}`,
          c.data,
        ]);
      }),
    );
    const transaction: SafeTransaction = {
      to: ADDRESSES.multiSend,
      value: "0",
      data: encodeFunctionData({
        abi: multiSendAbi,
        functionName: "multiSend",
        args: [packed],
      }),
      operation: 1,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: "0x0000000000000000000000000000000000000000",
      refundReceiver: "0x0000000000000000000000000000000000000000",
      nonce: info.nonce,
    };
    return {
      safe: info,
      transaction,
      safeTxHash: hashOf(safe, transaction),
      typedData: {
        domain: { chainId: 4663, verifyingContract: safe },
        types: safeTypedTypes,
        primaryType: "SafeTx",
        message: transaction,
      },
    };
  };
  chain.ownerOfSignature = async (
    safe: Address,
    tx: SafeTransaction,
    signature: Hex,
  ) =>
    lower(
      await recoverTypedDataAddress({
        domain: { chainId: 4663, verifyingContract: safe },
        types: safeTypedTypes,
        primaryType: "SafeTx",
        message: typedSafeMessage(tx),
        signature,
      }),
    );
  chain.execution = encodeSafeExecution;
  chain.confirmedSafeTransaction = async (
    txHash: Hex,
    safe: Address,
    safeTxHash: Hex,
  ) => {
    const e = executed.get(txHash.toLowerCase());
    return (
      !!e &&
      e.safe === lower(safe) &&
      e.safeTxHash.toLowerCase() === safeTxHash.toLowerCase()
    );
  };

  function apply(safe: Address, to: Address, data: Hex) {
    const s = safeState(safe),
      target = lower(to);
    if (target === lower(safe)) {
      const call = decode(safeAbi, data);
      if (call?.functionName === "enableModule") s.moduleEnabled = true;
      return;
    }
    if (target === lower(ADDRESSES.allowanceModule)) {
      const call = decode(allowanceAbi, data);
      if (call?.functionName === "setAllowance")
        allowances.set(lower(call.args[0]), BigInt(call.args[2]));
      if (call?.functionName === "removeDelegate")
        allowances.delete(lower(call.args[0]));
      return;
    }
    if (target !== lower(registry)) return; // Safe drafts: simulated as a no-op call.
    const call = decodeFunctionData({ abi: registryAbi, data }) as any;
    const officeOf = (id: Hex) => {
      const o = offices.get(id);
      if (!o) throw new Error("Registry: unknown Office");
      return o;
    };
    switch (call.functionName) {
      case "open": {
        const [seatRoot, policyHash, cap] = call.args;
        const id = officeIdFor(lower(safe));
        offices.set(id, {
          id,
          safe: lower(safe),
          seatRoot,
          policyHash,
          capUnits: BigInt(cap),
          spentUnits: 0n,
          periodStart: Math.floor(Date.now() / 60000),
          active: true,
          allowanceUnits: 0n,
          allowanceSpentUnits: 0n,
          allowancePeriod: Math.floor(Date.now() / 60000),
          allowanceInterval: 43200,
          safeBalanceUnits: 1000n * 1000000n, // 1,000 pretend USDG in the Safe
          clerks: new Set(),
        });
        break;
      }
      case "setSeats":
        officeOf(call.args[0]).seatRoot = call.args[1];
        break;
      case "setPolicy":
        officeOf(call.args[0]).policyHash = call.args[1];
        break;
      case "setCap":
        officeOf(call.args[0]).capUnits = BigInt(call.args[1]);
        break;
      case "setClerk": {
        const o = officeOf(call.args[0]),
          actor = String(call.args[1]).toLowerCase();
        if (call.args[2]) o.clerks.add(actor);
        else o.clerks.delete(actor);
        break;
      }
      case "close":
        officeOf(call.args[0]).active = false;
        break;
    }
  }

  /** Pretend to mine an execTransaction sent by the test wallet. */
  async function execute(safe: Address, data: Hex): Promise<Hex> {
    if (fixtureSafes.has(lower(safe)))
      throw new Error(
        "The ready-made QA Office’s Safe isn’t held by the test wallet.",
      );
    const s = safeState(safe),
      call = decodeFunctionData({ abi: safeAbi, data }) as any;
    if (call.functionName !== "execTransaction")
      throw new Error("The test wallet only sends Safe executions.");
    const [
      to,
      value,
      inner,
      operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      signatures,
    ] = call.args;
    const tx: SafeTransaction = {
      to,
      value: value.toString(),
      data: inner,
      operation,
      safeTxGas: safeTxGas.toString(),
      baseGas: baseGas.toString(),
      gasPrice: gasPrice.toString(),
      gasToken,
      refundReceiver,
      nonce: s.nonce.toString(),
    };
    const safeTxHash = hashOf(safe, tx),
      signers = new Set<string>();
    const sigs = (signatures as Hex).slice(2);
    for (let i = 0; i + 130 <= sigs.length; i += 130)
      signers.add(
        lower(
          await recoverAddress({
            hash: safeTxHash,
            signature: `0x${sigs.slice(i, i + 130)}`,
          }),
        ),
      );
    const valid = [...signers].filter((o) => s.owners.includes(o as Address));
    if (valid.length < s.threshold)
      throw new Error(
        "Safe rejected the execution: not enough owner signatures.",
      );
    if (lower(to) === lower(ADDRESSES.multiSend) && operation === 1) {
      const packed = decodeFunctionData({
        abi: multiSendAbi,
        data: inner,
      }).args[0].slice(2);
      let i = 0;
      while (i < packed.length) {
        const target = `0x${packed.slice(i + 2, i + 42)}` as Address;
        const length = Number(
          hexToBigInt(`0x${packed.slice(i + 106, i + 170)}`),
        );
        const callData =
          `0x${packed.slice(i + 170, i + 170 + length * 2)}` as Hex;
        apply(safe, target, callData);
        i += 170 + length * 2;
      }
    } else apply(safe, to, inner);
    s.nonce += 1n;
    const txHash = `0x${randomBytes(32).toString("hex")}` as Hex;
    executed.set(txHash, { safe: lower(safe), safeTxHash });
    return txHash;
  }

  /** JSON-RPC subset the dashboard uses, answered with the test key. */
  async function wallet(method: string, params: any[] = []) {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [TESTER.address];
      case "eth_chainId":
        return "0x1237";
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return null;
      case "personal_sign":
        return TESTER.signMessage({ message: { raw: params[0] as Hex } });
      case "eth_signTypedData_v4": {
        const typed = JSON.parse(params[1]);
        const { EIP712Domain: _, ...types } = typed.types;
        return TESTER.signTypedData({
          domain: {
            ...typed.domain,
            chainId:
              typeof typed.domain.chainId === "string" &&
              typed.domain.chainId.startsWith("0x")
                ? hexToNumber(typed.domain.chainId)
                : Number(typed.domain.chainId),
          },
          types,
          primaryType: typed.primaryType,
          message:
            typed.primaryType === "SafeTx"
              ? typedSafeMessage(typed.message)
              : typed.message,
        });
      }
      case "eth_sendTransaction": {
        const [tx] = params;
        if (lower(tx.from) !== lower(TESTER.address))
          throw new Error(
            "The test wallet can only send from its own account.",
          );
        return await execute(lower(tx.to), tx.data);
      }
      default:
        throw Object.assign(
          new Error(`The test wallet doesn’t support ${method}.`),
          {
            code: 4200,
          },
        );
    }
  }
  return { wallet };
}

/** Classic script injected into the fixture page. Announces an EIP-6963 wallet
 *  whose requests are signed by the fixture server with the throwaway key. */
export const walletScript = `(() => {
  const icon = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#6a70e0"/><path d="M9 12h14v10H9z" fill="none" stroke="#fff" stroke-width="2"/><circle cx="19" cy="17" r="1.6" fill="#fff"/></svg>');
  const info = Object.freeze({ uuid: "chancery-local-test-wallet", name: "Test wallet · local only", icon, rdns: "test.chancery.local" });
  const provider = {
    async request({ method, params }) {
      const r = await fetch("/__qa/wallet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: params || [] }) });
      const body = await r.json();
      if (!r.ok) { const e = new Error(body.message || "Test wallet error"); e.code = body.code; throw e; }
      return body.result;
    },
    on() {}, removeListener() {},
  };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();`;
