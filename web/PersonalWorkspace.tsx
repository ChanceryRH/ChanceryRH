import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  ShieldCheck,
  Wallet,
  Sparkles,
  Users,
} from "lucide-react";
import { decodeEventLog, type Address, type Hex } from "viem";
import { api, short, type Account, type AppConfig, type Model } from "./api";
import { Button, Feedback, Field, Panel, useAction } from "./ui";
import {
  connect,
  discoverWallets,
  ensureOwner,
  sendSafe,
  signSafe,
  type WalletProvider,
} from "./wallet";
import { ADDRESSES } from "../shared/chain";
import {
  personalClient,
  personalDeployment,
  verifyPersonalSafe,
  verifyPersonalTransaction,
  verifyPersonalActivation,
  fundingCall,
  fundingTokenAbi,
  fundingUnits,
  type PendingPersonalTransaction,
} from "./personal-wallet";

type Setup = {
  owner: string;
  amount: string;
  nonce: string;
  safe?: Address;
  officeId?: string;
  pending?: PendingPersonalTransaction;
  complete?: boolean;
  reverted?: boolean;
};
const storageKey = (id: string) => `chancery:personal-funding:${id}`;
export function personalSetup(id: string): Setup | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(id)) || "null");
    return value &&
      typeof value.owner === "string" &&
      typeof value.nonce === "string" &&
      typeof value.amount === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}
export function PersonalWorkspace({
  account,
  config,
  models,
  provider,
  setProvider,
  ready,
  openTeam,
  joinTeam,
}: {
  account: Account;
  config: AppConfig;
  models: Model[];
  provider: WalletProvider | null;
  setProvider: (p: WalletProvider) => void;
  ready: (id: string) => Promise<void>;
  openTeam: () => void;
  joinTeam: () => void;
}) {
  const action = useAction(),
    [saved, setSaved] = useState(() => personalSetup(account.id)),
    [amount, setAmount] = useState(
      () => personalSetup(account.id)?.amount || "25",
    ),
    [stage, setStage] = useState(""),
    [recovery, setRecovery] = useState("");
  function save(s: Setup) {
    localStorage.setItem(storageKey(account.id), JSON.stringify(s));
    setSaved({ ...s });
  }
  async function start() {
    if (!account.wallet)
      throw new Error(
        "Sign in with your wallet to fund your personal workspace.",
      );
    if (!config.registry)
      throw new Error(
        "Funding is temporarily unavailable. Please try again shortly.",
      );
    fundingUnits(amount);
    if (!navigator.locks)
      throw new Error(
        "Use a current browser with secure wallet support to fund your workspace.",
      );
    await navigator.locks.request(
      storageKey(account.id),
      { ifAvailable: true },
      async (lock) => {
        if (!lock)
          throw new Error(
            "Funding is already open in another tab. Continue there.",
          );
        let s = personalSetup(account.id);
        if (s?.complete && s.officeId) {
          await ready(s.officeId);
          return;
        }
        if (
          s &&
          (s.owner.toLowerCase() !== account.wallet!.toLowerCase() ||
            s.amount !== amount)
        )
          throw new Error(
            "Resume with the wallet and amount used to start this funding request.",
          );
        const activeProvider = provider || discoverWallets()[0]?.provider;
        if (!activeProvider)
          throw new Error(
            "Open Chancery in your wallet browser or install a browser wallet.",
          );
        if (!provider) {
          const address = await connect(activeProvider);
          if (address.toLowerCase() !== account.wallet!.toLowerCase())
            throw new Error("Connect the wallet used to sign in.");
          setProvider(activeProvider);
        }
        const owner = await ensureOwner(activeProvider, account.wallet),
          client = personalClient(activeProvider);
        if (s?.pending?.phase !== "fund") {
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
              `Your wallet needs ${amount} USDG on Robinhood Chain before you start. No setup transaction has been requested.`,
            );
        }
        if (!s) {
          const bytes = crypto.getRandomValues(new Uint8Array(32));
          s = {
            owner,
            amount,
            nonce: BigInt(
              "0x" +
                Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
                  "",
                ),
            ).toString(),
          };
          save(s);
        }
        const state = s;
        async function transact(
          phase: PendingPersonalTransaction["phase"],
          to: Address,
          data: Hex,
          send?: () => Promise<Hex>,
        ) {
          await ensureOwner(activeProvider, account.wallet);
          if (
            state.pending &&
            (state.pending.phase !== phase ||
              state.pending.to.toLowerCase() !== to.toLowerCase() ||
              state.pending.data.toLowerCase() !== data.toLowerCase())
          )
            throw new Error(
              "The pending transaction differs from this request. Review it in your wallet before continuing.",
            );
          if (!state.pending) {
            state.pending = { phase, to, data };
            save(state);
            try {
              state.pending.hash = send
                ? await send()
                : await activeProvider.request({
                    method: "eth_sendTransaction",
                    params: [{ from: owner, to, data, value: "0x0" }],
                  });
              save(state);
            } catch (error) {
              if ((error as any)?.code === 4001) {
                delete state.pending;
                save(state);
              }
              throw error;
            }
          }
          if (recovery) {
            if (!/^0x[0-9a-fA-F]{64}$/.test(recovery))
              throw new Error(
                "Enter the full transaction hash from your wallet.",
              );
            state.pending.hash = recovery as Hex;
            save(state);
            setRecovery("");
          }
          try {
            return await verifyPersonalTransaction(
              client,
              owner,
              state.pending,
            );
          } catch (error) {
            if ((error as any)?.reverted) {
              state.reverted = true;
              save(state);
            }
            throw error;
          }
        }
        setStage("Preparing your personal Safe");
        const deployment = await personalDeployment(client, owner, state.nonce);
        if (
          state.safe &&
          state.safe.toLowerCase() !== deployment.safe.toLowerCase()
        )
          throw new Error(
            "Personal funding address mismatch. No funds were sent.",
          );
        state.safe = deployment.safe;
        save(state);
        const deployedCode = await client.getCode({ address: state.safe });
        if (!deployedCode || deployedCode === "0x") {
          await transact("deploy", ADDRESSES.safeFactory, deployment.data);
        }
        await verifyPersonalSafe(client, state.safe, owner);
        if (state.pending?.phase === "deploy") {
          delete state.pending;
          save(state);
        }
        setStage("Preparing your spending limit");
        let offices = await api.request<any[]>("/offices");
        let office = offices.find(
          (o) => o.safe.toLowerCase() === state.safe!.toLowerCase(),
        );
        if (!office) {
          const created = await api.request("/offices", {
            safe: state.safe,
            name: "Personal workspace",
            monthlyCap: state.amount,
          });
          state.officeId = created.officeId;
          save(state);
        } else {
          state.officeId = office.id;
          save(state);
        }
        const officeId = state.officeId!;
        let detail = await api.office(officeId);
        if (state.pending?.phase === "activate") {
          if (recovery) {
            if (!/^0x[0-9a-fA-F]{64}$/.test(recovery))
              throw new Error("Enter the full transaction hash.");
            state.pending.hash = recovery as Hex;
            save(state);
            setRecovery("");
          }
          const proposals = await api.office(officeId, "/proposals");
          const pending = proposals.find(
            (p: any) => p.kind === "open" && p.status === "pending",
          );
          if (pending) {
            if (state.pending.to.toLowerCase() !== state.safe.toLowerCase())
              throw new Error("Unexpected activation destination.");
            try {
              await verifyPersonalTransaction(client, owner, state.pending);
            } catch (error) {
              if ((error as any)?.reverted) {
                state.reverted = true;
                save(state);
              }
              throw error;
            }
            await api.office(officeId, `/proposals/${pending.id}/confirm`, {
              transactionHash: state.pending.hash,
            });
          }
          delete state.pending;
          save(state);
          detail = await api.office(officeId);
        }
        if (detail.status !== "active" || detail.seatStatus !== "active") {
          const proposals = await api.office(officeId, "/proposals");
          const pending = proposals.find(
            (p: any) => p.kind === "open" && p.status === "pending",
          );
          if (!pending)
            throw new Error(
              "Open Approvals to review the pending workspace setup.",
            );
          const proposal = await api.office(
            officeId,
            `/proposals/${pending.id}`,
          );
          verifyPersonalActivation(
            proposal.safe_tx,
            state.safe,
            config.registry as Address,
            detail.delegate,
            state.amount,
          );
          let execution = await api.office(
            officeId,
            `/proposals/${pending.id}/execution`,
          );
          if (!execution.ready) {
            setStage("Approve your spending limit in your wallet");
            const signature = await signSafe(
              activeProvider,
              account.wallet,
              state.safe,
              proposal.safe_tx,
              proposal.safe_tx_hash,
            );
            await api.office(officeId, `/proposals/${pending.id}/signatures`, {
              signature,
            });
            execution = await api.office(
              officeId,
              `/proposals/${pending.id}/execution`,
            );
          }
          if (
            !execution.ready ||
            execution.safeTxHash !== proposal.safe_tx_hash
          )
            throw new Error("Your spending approval changed. Review it again.");
          setStage("Activate your personal workspace in your wallet");
          await transact("activate", state.safe, execution.execution.data, () =>
            sendSafe(
              activeProvider,
              account.wallet,
              state.safe!,
              execution.execution,
              proposal.safe_tx,
              execution.signatures,
            ),
          );
          await api.office(officeId, `/proposals/${pending.id}/confirm`, {
            transactionHash: state.pending!.hash,
          });
          delete state.pending;
          save(state);
          detail = await api.office(officeId);
        }
        if (
          detail.status !== "active" ||
          detail.seatStatus !== "active" ||
          detail.threshold !== 1 ||
          detail.owners.length !== 1 ||
          detail.owners[0].toLowerCase() !== owner.toLowerCase()
        )
          throw new Error("Your personal workspace is not ready for funding.");
        if (state.pending?.phase === "activate") {
          delete state.pending;
          save(state);
        }
        setStage("Fund your workspace with USDG");
        await verifyPersonalSafe(client, state.safe, owner);
        const decimals = await client.readContract({
          address: ADDRESSES.usdg,
          abi: fundingTokenAbi,
          functionName: "decimals",
        });
        if (decimals !== 6)
          throw new Error(
            "Unexpected USDG token configuration. No funding was sent.",
          );
        if (!state.pending) {
          const balance = await client.readContract({
            address: ADDRESSES.usdg,
            abi: fundingTokenAbi,
            functionName: "balanceOf",
            args: [owner],
          });
          if (balance < fundingUnits(state.amount))
            throw new Error(
              `Your wallet needs ${state.amount} USDG on Robinhood Chain. Add USDG to your wallet, then continue here.`,
            );
        }
        const receipt = await transact(
          "fund",
          ADDRESSES.usdg,
          fundingCall(state.safe, state.amount),
        );
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
              event.args.to.toLowerCase() === state.safe!.toLowerCase() &&
              event.args.value === fundingUnits(state.amount)
            );
          } catch {
            return false;
          }
        });
        if (!transferred)
          throw new Error(
            "The transaction did not confirm the expected USDG transfer. Check it in your wallet before continuing.",
          );
        delete state.pending;
        state.complete = true;
        save(state);
        setStage("Your workspace is funded");
        await ready(officeId);
      },
    );
  }
  return (
    <div className="personal-workspace">
      <div className="personal-heading">
        <span className="eyebrow">YOUR PERSONAL WORKSPACE</span>
        <h1>Make room for your next idea.</h1>
        <p>
          Work on your own. Pick a model, fund your workspace, and get started.
        </p>
      </div>
      <div className="personal-grid">
        <Panel className="personal-tools">
          <Sparkles size={24} />
          <h2>One workspace. Your choice of AI.</h2>
          <p>
            Write, research, plan, and code with the models available to your
            account.
          </p>
          <div className="personal-use-cases">
            <span>
              <strong>Write &amp; edit</strong>Turn a first draft into something
              clear.
            </span>
            <span>
              <strong>Research &amp; compare</strong>Explore questions and
              different perspectives.
            </span>
            <span>
              <strong>Code &amp; debug</strong>Work through problems with your
              chosen model.
            </span>
          </div>
          <div className="personal-models">
            {models.slice(0, 9).map((m) => (
              <span key={m.id}>{m.name || m.id}</span>
            ))}
          </div>
          <div className="notice">
            <ShieldCheck size={18} />
            <span>
              You remain the only owner. Review each request’s maximum price
              before it runs.
            </span>
          </div>
        </Panel>
        <Panel className="personal-funding">
          <Wallet size={23} />
          <h2>Fund it. Make it yours.</h2>
          <p>
            USDG stays in a personal Safe controlled by your wallet. No team
            setup required.
          </p>
          <Field
            label="Add funds · USDG"
            help="This also sets your initial 30-day spending limit."
          >
            <input
              type="number"
              min="0.01"
              max="5000"
              step="0.01"
              value={amount}
              disabled={!!saved || action.busy}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <p className="muted">
            9 USDG per month, prorated daily, plus AI usage and a 5% platform
            fee. Network gas is paid separately in ETH.
          </p>
          {saved?.safe && (
            <p className="muted">
              Your Safe:{" "}
              <a
                href={`https://robinhoodchain.blockscout.com/address/${saved.safe}`}
                target="_blank"
                rel="noreferrer"
              >
                {short(saved.safe)}
              </a>
            </p>
          )}
          {stage && (
            <div className="personal-progress" role="status">
              <Check size={16} />
              {stage}
            </div>
          )}
          <Feedback action={action} />
          {saved?.pending && !action.busy && (
            <Field
              label="Resume a submitted transaction"
              help="If your wallet submitted it but the page lost its hash, paste that hash. We will verify it before continuing."
            >
              <input
                placeholder={saved.pending.hash || "0x… transaction hash"}
                value={recovery}
                onChange={(e) => setRecovery(e.target.value.trim())}
              />
            </Field>
          )}
          {saved?.reverted && !action.busy && (
            <Button
              kind="secondary"
              onClick={() => {
                const state = { ...saved };
                delete state.pending;
                delete state.reverted;
                save(state);
                action.setError("");
              }}
            >
              Retry reverted transaction
            </Button>
          )}
          <Button
            busy={action.busy}
            disabled={!account.wallet || !config.registry || !!saved?.reverted}
            onClick={() => action.run(start)}
          >
            {saved ? "Continue funding" : "Fund personal workspace"}
            <ArrowUpRight size={16} />
          </Button>
          {!account.wallet && (
            <p className="muted">
              Sign out and sign in with your wallet to fund a personal
              workspace.
            </p>
          )}
          <small className="personal-wallet-note">
            Your wallet will ask you to create your personal Safe, approve its
            spending limit, and transfer the amount you chose.
          </small>
        </Panel>
      </div>
      <div className="personal-team">
        <Users size={18} />
        <span>Working with a team?</span>
        <Button kind="ghost" onClick={openTeam}>
          Open a team Office
        </Button>
        <Button kind="ghost" onClick={joinTeam}>
          Join a team
        </Button>
      </div>
    </div>
  );
}
