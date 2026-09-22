import { hashTypedData, stringToHex, type Address, type Hex } from "viem";
import { RHC, type SafeTransaction } from "../shared/chain";
import { safeTypedTypes, encodeSafeExecution } from "../shared/safe-signing";
export type WalletProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
  on?(event: string, listener: (value: any) => void): void;
  removeListener?(event: string, listener: (value: any) => void): void;
};
export type Wallet = { id: string; name: string; provider: WalletProvider };
declare global {
  interface Window {
    ethereum?: WalletProvider;
  }
}
const wallets: Wallet[] = [];
const subscribers = new Set<() => void>();
window.addEventListener("eip6963:announceProvider", ((event: CustomEvent) => {
  const detail = event.detail;
  if (
    !detail?.provider?.request ||
    !detail.info?.uuid ||
    wallets.some((w) => w.id === detail.info.uuid)
  )
    return;
  wallets.push({
    id: detail.info.uuid,
    name: String(detail.info.name).slice(0, 80),
    provider: detail.provider,
  });
  subscribers.forEach((fn) => fn());
}) as EventListener);
window.dispatchEvent(new Event("eip6963:requestProvider"));
export function discoverWallets() {
  return wallets.length
    ? [...wallets]
    : window.ethereum
      ? [{ id: "injected", name: "Browser wallet", provider: window.ethereum }]
      : [];
}
export function watchWallets(fn: () => void) {
  subscribers.add(fn);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return () => {
    subscribers.delete(fn);
  };
}
export async function connect(provider: WalletProvider) {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!accounts?.[0]) throw new Error("No wallet account was selected.");
  return accounts[0] as Address;
}
export async function ensureOwner(
  provider: WalletProvider | null,
  expected: string | null,
) {
  if (!provider || !expected)
    throw new Error(
      "Connect the wallet you used to sign in before approving a Safe change.",
    );
  const accounts = await provider.request({ method: "eth_accounts" });
  if (accounts?.[0]?.toLowerCase() !== expected.toLowerCase())
    throw new Error(
      "Your wallet account changed. Sign out and sign in with the intended Safe owner.",
    );
  if (Number(await provider.request({ method: "eth_chainId" })) !== RHC.id) {
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${RHC.id.toString(16)}` }],
      });
    } catch (error: any) {
      if (error.code !== 4902) throw error;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: `0x${RHC.id.toString(16)}`,
            chainName: RHC.name,
            nativeCurrency: RHC.nativeCurrency,
            rpcUrls: [...RHC.rpcUrls.default.http],
            blockExplorerUrls: [RHC.blockExplorers.default.url],
          },
        ],
      });
    }
    if (Number(await provider.request({ method: "eth_chainId" })) !== RHC.id)
      throw new Error("Switch your wallet to Robinhood Chain to continue.");
  }
  const latest = await provider.request({ method: "eth_accounts" });
  if (latest?.[0]?.toLowerCase() !== expected.toLowerCase())
    throw new Error("Your wallet account changed. Sign in again.");
  return expected as Address;
}
export async function signInMessage(
  provider: WalletProvider,
  address: Address,
  message: string,
) {
  return provider.request({
    method: "personal_sign",
    params: [stringToHex(message), address],
  });
}
export async function signSafe(
  provider: WalletProvider | null,
  owner: string | null,
  safe: string,
  tx: SafeTransaction,
  expectedHash: string,
) {
  const address = await ensureOwner(provider, owner);
  const typed = {
    domain: { chainId: RHC.id, verifyingContract: safe as Address },
    types: safeTypedTypes,
    primaryType: "SafeTx" as const,
    message: {
      ...tx,
      value: BigInt(tx.value),
      safeTxGas: BigInt(tx.safeTxGas),
      baseGas: BigInt(tx.baseGas),
      gasPrice: BigInt(tx.gasPrice),
      nonce: BigInt(tx.nonce),
    },
  };
  if (hashTypedData(typed).toLowerCase() !== expectedHash.toLowerCase())
    throw new Error(
      "The proposal hash does not match its transaction. Do not sign this proposal.",
    );
  const payload = {
    ...typed,
    types: {
      EIP712Domain: [
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...safeTypedTypes,
    },
  };
  return provider!.request({
    method: "eth_signTypedData_v4",
    params: [
      address,
      JSON.stringify(payload, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ],
  });
}
export async function sendSafe(
  provider: WalletProvider | null,
  owner: string | null,
  safe: string,
  execution: { to: string; data: string; value: string; chainId: number },
  reviewedTransaction: SafeTransaction,
  signatures: { owner: string; signature: Hex }[],
) {
  const address = await ensureOwner(provider, owner);
  if (
    execution.chainId !== RHC.id ||
    execution.to.toLowerCase() !== safe.toLowerCase() ||
    execution.value !== "0" ||
    execution.data.toLowerCase() !==
      encodeSafeExecution(reviewedTransaction, signatures).toLowerCase()
  )
    throw new Error("Unexpected Safe execution details. Refresh the proposal.");
  return provider!.request({
    method: "eth_sendTransaction",
    params: [
      { from: address, to: execution.to, data: execution.data, value: "0x0" },
    ],
  }) as Promise<Hex>;
}
