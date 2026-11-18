"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeFunctionData, erc20Abi, toHex } from "viem";
import { useActiveWallet } from "@/components/app/ActiveWallet";
import { signTransaction as signStellarTransaction } from "@/lib/stellar/wallet-adapter";
import { BRIDGE_CHAINS } from "@/lib/bridge/chains";
import {
  RegisterRetryableError,
  runBridgeFlow,
  type BridgeFlowDeps,
  type FlowStep,
} from "@/lib/bridge/bridge-flow";
import { pollBridgeStatus } from "@/lib/bridge/poll-status";
import {
  knownAddressesKey,
  recipientOf,
  sourceWalletOf,
  type BridgeFormState,
  type LoadedQuote,
} from "@/lib/bridge/form-state";
import type { SourceTx } from "@/lib/bridge/build-source-tx";
import type { BridgeStatusView } from "@/lib/bridge/bridge-store";

export type FlowPhase =
  | { kind: "idle" }
  | { kind: "running"; step: FlowStep | "tracking"; txHash?: string; view?: BridgeStatusView }
  | { kind: "reconfirm"; quote: LoadedQuote }
  | { kind: "stillGoing"; txHash: string; view?: BridgeStatusView }
  | { kind: "done"; view: BridgeStatusView }
  | { kind: "error"; message: string; txHash?: string; view?: BridgeStatusView };

type BuiltTx = SourceTx & { networkPassphrase?: string };

async function postJson<T>(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; body: Partial<T> & { error?: string; code?: string } }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Plain-words reason for a failure before anything was sent. */
function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? "");
  if (/reject|denied|cancel/i.test(m)) return "You cancelled in your wallet. Nothing was sent.";
  return m ? `${m} Nothing was sent.` : "Something went wrong. Nothing was sent.";
}

function rememberAddress(user: string, address: string) {
  try {
    const key = knownAddressesKey(user);
    const list = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    const next: string[] = Array.isArray(list) ? list : [];
    if (!next.includes(address.toLowerCase())) next.push(address.toLowerCase());
    window.localStorage.setItem(key, JSON.stringify(next.slice(-50)));
  } catch {
    // storage unavailable: the address stays first-time next time
  }
}

/**
 * Runs one bridge from the form's current quote (plan Task 20): wallet
 * steps through runBridgeFlow, then server status through pollBridgeStatus.
 */
export function useBridgeFlow() {
  const wallets = useActiveWallet();
  const [phase, setPhase] = useState<FlowPhase>({ kind: "idle" });
  const stopPoll = useRef<(() => void) | null>(null);

  useEffect(() => () => stopPoll.current?.(), []);

  const track = useCallback((txHash: string, first?: BridgeStatusView) => {
    stopPoll.current?.();
    setPhase({ kind: "running", step: "tracking", txHash, view: first });
    stopPoll.current = pollBridgeStatus(
      txHash,
      (view) => {
        if (view.status === "completed") setPhase({ kind: "done", view });
        else if (view.status === "failed") {
          setPhase({ kind: "error", message: "This bridge didn't complete.", txHash, view });
        } else setPhase({ kind: "running", step: "tracking", txHash, view });
      },
      undefined,
      () => setPhase((p) => ({ kind: "stillGoing", txHash, view: "view" in p ? p.view : undefined })),
    );
  }, []);

  const start = useCallback(
    async (form: BridgeFormState) => {
      const quote = form.quote;
      const user = sourceWalletOf(form);
      if (!quote || !user) return;
      const source = form.source;
      const chain = BRIDGE_CHAINS[source];
      // Set once the source tx is broadcast: from then on the funds are
      // moving, and a later failure is a tracking problem, not "nothing sent".
      let sentHash: string | null = null;

      const buildTx = async (q: LoadedQuote): Promise<BuiltTx> => {
        const r = await postJson<BuiltTx>("/api/bridge/build-tx", { quote: q, userAddress: user });
        if (!r.ok || !r.body.family) throw new Error(r.body.error ?? "Couldn't prepare the transaction.");
        return r.body as BuiltTx;
      };

      const sendSigned = async (t: BuiltTx): Promise<string> => {
        switch (t.family) {
          case "evm": {
            await wallets.evm.switchChain(t.chainId);
            const value = BigInt(t.value);
            const [hash] = await wallets.evm.signAndSendCalls(
              [{ to: t.to, data: t.data, ...(value > BigInt(0) ? { value: toHex(value) } : {}) }],
              t.chainId,
            );
            return hash;
          }
          case "stellar": {
            const signed = await signStellarTransaction(t.xdr, user, t.networkPassphrase);
            const r = await postJson<{ hash: string }>("/api/bridge/submit-stellar", { signedXdr: signed });
            if (!r.ok || !r.body.hash) throw new Error(r.body.error ?? "Couldn't submit the transaction.");
            return r.body.hash;
          }
          case "solana":
            return wallets.solana.signAndSendPrepared(t.txBase64);
        }
      };

      const deps: BridgeFlowDeps = {
        now: () => Math.floor(Date.now() / 1000),
        refreshQuote: async () => {
          const r = await postJson<LoadedQuote>("/api/bridge/quote", {
            source,
            dest: form.dest,
            amount: form.amount.trim(),
            speed: form.speed,
            user,
            recipient: recipientOf(form),
            networkFeeMode: form.networkFeeMode,
          });
          if (!r.ok || !r.body.quote) throw new Error(r.body.error ?? "Couldn't refresh your price.");
          return r.body as LoadedQuote;
        },
        buildTx,
        approve: async (q, tx) => {
          await wallets.evm.switchChain(tx.chainId);
          const data = encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [q.contract as `0x${string}`, BigInt(q.quote.amount)],
          });
          await wallets.evm.signAndSendCalls([{ to: chain.usdc as `0x${string}`, data }], tx.chainId);
          // Wait until the server sees the allowance before building the bridge tx.
          for (let i = 0; i < 30; i++) {
            await sleep(3_000);
            const again = await buildTx(q);
            if (again.family !== "evm" || !again.needsApproval) return;
          }
          throw new Error("The USDC approval hasn't confirmed yet. Try again in a minute.");
        },
        signAndSend: async (tx) => {
          const hash = await sendSigned(tx as BuiltTx);
          sentHash = hash;
          return hash;
        },
        register: async (c, txHash) => {
          const r = await postJson<BridgeStatusView>("/api/bridge/register", { chain: c, txHash });
          if (r.ok && r.body.id) return r.body as BridgeStatusView;
          if (r.status === 409 || r.status === 503) throw new RegisterRetryableError(r.body.error ?? "not yet");
          throw new Error(r.body.error ?? "Couldn't register the bridge.");
        },
        sleep,
        onStep: (step) => setPhase({ kind: "running", step }),
      };

      setPhase({ kind: "running", step: "confirm" });
      try {
        const r = await runBridgeFlow({ quote, source, user }, deps);
        if (r.kind === "needsReconfirm") {
          setPhase({ kind: "reconfirm", quote: r.quote });
          return;
        }
        if (!form.useConnectedDest) rememberAddress(user, recipientOf(form));
        track(r.txHash, r.kind === "registered" ? r.view : undefined);
      } catch (e) {
        if (sentHash) {
          // Sent but not registered: the event sweep registers it; keep following it.
          if (!form.useConnectedDest) rememberAddress(user, recipientOf(form));
          track(sentHash);
          return;
        }
        setPhase({ kind: "error", message: friendly(e) });
      }
    },
    [wallets, track],
  );

  /** "Claim it yourself": the destination EVM wallet submits the mint. */
  const claim = useCallback(
    async (view: BridgeStatusView) => {
      const res = await fetch(`/api/bridge/${encodeURIComponent(view.id)}/claim`, { cache: "no-store" });
      const tx = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(tx.error ?? "This bridge can't be claimed right now.");
      await wallets.evm.switchChain(tx.chainId);
      await wallets.evm.signAndSendCalls([{ to: tx.to, data: tx.data }], tx.chainId);
      track(view.id, view);
    },
    [wallets, track],
  );

  const reset = useCallback(() => {
    stopPoll.current?.();
    stopPoll.current = null;
    setPhase({ kind: "idle" });
  }, []);

  return { phase, start, claim, reset };
}
