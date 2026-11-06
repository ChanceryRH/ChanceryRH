import { useState } from "react";
import { Wallet } from "lucide-react";
import { decodeEventLog, type Address, type Hex } from "viem";
import { type Account, type Office, short } from "./api";
import { Button, Feedback, Field, Modal, useAction } from "./ui";
import {
  connect,
  discoverWallets,
  ensureOwner,
  type WalletProvider,
} from "./wallet";
import { ADDRESSES } from "../shared/chain";
import {
  personalClient,
  verifyPersonalSafe,
  fundingUnits,
  fundingCall,
  fundingTokenAbi,
  verifyPersonalTransaction,
  type PendingPersonalTransaction,
} from "./personal-wallet";
type Deposit = {
  amount: string;
  pending: PendingPersonalTransaction;
  reverted?: boolean;
};
export function PersonalFunding({
  account,
  office,
  provider,
  setProvider,
  close,
  refresh,
}: {
  account: Account;
  office: Office;
  provider: WalletProvider | null;
  setProvider: (p: WalletProvider) => void;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const key = `chancery:deposit:${account.id}:${office.id}`,
    action = useAction();
  const read = (): Deposit | null => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  };
  const [saved, setSaved] = useState(read),
    [amount, setAmount] = useState(() => read()?.amount || "25"),
    [recovery, setRecovery] = useState("");
  const save = (state: Deposit | null) => {
    if (state) localStorage.setItem(key, JSON.stringify(state));
    else localStorage.removeItem(key);
    setSaved(state);
  };
  async function fund() {
    if (!account.wallet)
      throw new Error("Sign in with your wallet to add funds.");
    fundingUnits(amount);
    if (!navigator.locks)
      throw new Error("Use a current browser with secure wallet support.");
    await navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
      if (!lock)
        throw new Error("A funding request is already open in another tab.");
      const wallet = provider || discoverWallets()[0]?.provider;
      if (!wallet)
        throw new Error(
          "Open Chancery in a browser with your wallet installed.",
        );
      if (!provider) {
        const address = await connect(wallet);
        if (address.toLowerCase() !== account.wallet!.toLowerCase())
          throw new Error("Connect the wallet used to sign in.");
        setProvider(wallet);
      }
      const owner = await ensureOwner(wallet, account.wallet),
        client = personalClient(wallet),
        safe = office.safe as Address;
      await verifyPersonalSafe(client, safe, owner);
      const data = fundingCall(safe, amount);
      let state = read();
      if (
        state &&
        (state.amount !== amount ||
          state.pending.to.toLowerCase() !== ADDRESSES.usdg.toLowerCase() ||
          state.pending.data !== data)
      )
        throw new Error("Resume the original funding request first.");
      if (!state) {
        const decimals = await client.readContract({
          address: ADDRESSES.usdg,
          abi: fundingTokenAbi,
          functionName: "decimals",
        });
        if (decimals !== 6) throw new Error("Unexpected USDG configuration.");
        const balance = await client.readContract({
          address: ADDRESSES.usdg,
          abi: fundingTokenAbi,
          functionName: "balanceOf",
          args: [owner],
        });
        if (balance < fundingUnits(amount))
          throw new Error(
            `Your wallet needs ${amount} USDG on Robinhood Chain.`,
          );
        state = {
          amount,
          pending: { phase: "fund", to: ADDRESSES.usdg, data },
        };
        save(state);
        try {
          state.pending.hash = await wallet.request({
            method: "eth_sendTransaction",
            params: [{ from: owner, to: ADDRESSES.usdg, data, value: "0x0" }],
          });
          save({ ...state });
        } catch (error) {
          if ((error as any)?.code === 4001) save(null);
          throw error;
        }
      }
      if (recovery) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(recovery))
          throw new Error("Enter the full transaction hash.");
        state.pending.hash = recovery as Hex;
        save({ ...state });
      }
      let receipt;
      try {
        receipt = await verifyPersonalTransaction(client, owner, state.pending);
      } catch (error) {
        if ((error as any)?.reverted) {
          state.reverted = true;
          save({ ...state });
        }
        throw error;
      }
      const transferred = receipt.logs.some((log) => {
        if (log.address.toLowerCase() !== ADDRESSES.usdg.toLowerCase())
          return false;
        try {
          const event = decodeEventLog({
            abi: fundingTokenAbi,
            data: log.data,
            topics: log.topics,
          });
          return (
            event.eventName === "Transfer" &&
            event.args.from.toLowerCase() === owner.toLowerCase() &&
            event.args.to.toLowerCase() === safe.toLowerCase() &&
            event.args.value === fundingUnits(amount)
          );
        } catch {
          return false;
        }
      });
      if (!transferred)
        throw new Error(
          "The expected USDG transfer was not confirmed. Check your wallet transaction.",
        );
      save(null);
      await refresh();
      action.setNotice(`${amount} USDG added to your personal workspace.`);
    });
  }
  return (
    <Modal
      title="Add USDG"
      close={() => {
        if (!action.busy) close();
      }}
    >
      <p>
        Transfer USDG from your wallet to your personal Safe on Robinhood Chain.
      </p>
      <p className="muted">
        Your Safe: {short(office.safe)} · Network gas is paid in ETH.
      </p>
      <Field label="Amount · USDG">
        <input
          type="number"
          min="0.01"
          max="5000"
          step="0.01"
          value={amount}
          disabled={action.busy || !!saved}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <p className="muted">
        Adding funds does not change your {office.capUsd} USDG spending limit
        per 30 days. You can review that limit in Settings.
      </p>
      <Feedback action={action} />
      {saved && !action.busy && (
        <Field label="Resume with your wallet transaction hash">
          <input
            value={recovery}
            placeholder={saved.pending.hash || "0x…"}
            onChange={(e) => setRecovery(e.target.value.trim())}
          />
        </Field>
      )}
      {saved?.reverted && (
        <Button
          kind="secondary"
          onClick={() => {
            save(null);
            action.setError("");
          }}
        >
          Retry reverted transfer
        </Button>
      )}
      <Button
        busy={action.busy}
        disabled={!!saved?.reverted}
        onClick={() => action.run(fund)}
      >
        <Wallet size={16} />
        {saved ? "Check funding transaction" : "Add funds"}
      </Button>
    </Modal>
  );
}
