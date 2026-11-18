/**
 * The user's side of one bridge (plan Task 20): refresh an expiring quote,
 * approve USDC on EVM if needed, build the source tx, have the wallet sign and
 * send it, then register it with the server. Wallets and network calls are
 * injected so the order of operations is tested without either.
 *
 * Once the source tx is sent the funds are moving: registration failing only
 * means the screen can't follow it yet. The server's event sweep registers
 * every Bridged event on its own (spec §9), so that case is reported as
 * `sentUnregistered`, never as a failure.
 */

import type { BridgeChainKey } from "./chains";
import type { QuoteSuccess } from "./build-quote";
import type { SourceTx } from "./build-source-tx";
import type { BridgeStatusView } from "./bridge-store";

/** Refresh the quote when fewer than this many seconds are left on it. */
export const MIN_QUOTE_LIFE_S = 20;
const REGISTER_ATTEMPTS = 8;
const REGISTER_BACKOFF_MS = [2_000, 3_000, 5_000, 5_000, 8_000, 10_000, 10_000];

export type FlowStep = "approve" | "confirm" | "sending";

/** Thrown by `register` for "not indexed yet" / temporarily unavailable. */
export class RegisterRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegisterRetryableError";
  }
}

export interface BridgeFlowDeps {
  /** Unix seconds. */
  now(): number;
  refreshQuote(): Promise<QuoteSuccess>;
  buildTx(quote: QuoteSuccess): Promise<SourceTx>;
  /** EVM: send approve(contract, amount) and wait for it to confirm. */
  approve(quote: QuoteSuccess, tx: Extract<SourceTx, { family: "evm" }>): Promise<void>;
  /** Wallet signs and the tx is broadcast; resolves with its hash once sent. */
  signAndSend(tx: SourceTx): Promise<string>;
  register(chain: BridgeChainKey, txHash: string): Promise<BridgeStatusView>;
  sleep(ms: number): Promise<void>;
  onStep(step: FlowStep): void;
}

export type FlowResult =
  | { kind: "needsReconfirm"; quote: QuoteSuccess }
  | { kind: "registered"; txHash: string; view: BridgeStatusView }
  | { kind: "sentUnregistered"; txHash: string };

export async function runBridgeFlow(
  input: { quote: QuoteSuccess; source: BridgeChainKey; user: string },
  d: BridgeFlowDeps,
): Promise<FlowResult> {
  // Review focus 1: never let the wallet sign a quote that expires before it lands.
  if (input.quote.expiresAt - d.now() < MIN_QUOTE_LIFE_S) {
    return { kind: "needsReconfirm", quote: await d.refreshQuote() };
  }
  const quote = input.quote;

  let tx = await d.buildTx(quote);
  if (tx.family === "evm" && tx.needsApproval) {
    d.onStep("approve");
    await d.approve(quote, tx);
    // The approval can take most of the quote's life (wallet confirmation
    // plus on-chain confirmation). Re-check before signing the bridge; the
    // allowance stays, so the reconfirmed run goes straight to signing.
    if (quote.expiresAt - d.now() < MIN_QUOTE_LIFE_S) {
      return { kind: "needsReconfirm", quote: await d.refreshQuote() };
    }
    tx = await d.buildTx(quote);
  }

  d.onStep("confirm");
  const txHash = await d.signAndSend(tx);
  d.onStep("sending");

  for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt++) {
    try {
      return { kind: "registered", txHash, view: await d.register(input.source, txHash) };
    } catch (e) {
      if (!(e instanceof RegisterRetryableError)) throw e;
      if (attempt < REGISTER_ATTEMPTS - 1) await d.sleep(REGISTER_BACKOFF_MS[attempt] ?? 10_000);
    }
  }
  return { kind: "sentUnregistered", txHash };
}

const LABEL: Record<string, string> = {
  stellar: "Stellar",
  ethereum: "Ethereum",
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  avalanche: "Avalanche",
  polygon: "Polygon",
  solana: "Solana",
};

/** The line describing where a registered bridge is now. */
export function progressCopy(v: BridgeStatusView): string {
  switch (v.status) {
    case "submitted":
    case "verifying":
      return v.fellBackToStandard ? "Taking the standard route — still on its way" : "Verifying the transfer";
    case "delivering":
      return v.fellBackToStandard
        ? "Taking the standard route — still on its way"
        : `Delivering on ${LABEL[v.dest] ?? v.dest}`;
    case "completed":
      return "Arrived in your wallet";
    case "failed":
      return "This bridge didn't complete";
  }
}

/** The actions the progress/result view offers for this state. */
export function resultActions(v: BridgeStatusView): string[] {
  const actions: string[] = [];
  if (v.status === "completed") actions.push("View transaction", "Offramp to naira");
  if (v.canSelfClaim) actions.push("Claim it yourself");
  if (v.status === "failed" && !v.canSelfClaim) actions.push("View transaction");
  return actions;
}
