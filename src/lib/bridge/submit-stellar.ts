/**
 * Submits a user-signed Stellar bridge transaction to Soroban RPC and waits
 * briefly for it to land (CCTP_CONFIG.stellarRpcUrl, testnet-aware).
 *
 * Only a single `bridge` call on Settu's own bridge contract is relayed, so
 * this route can't be used to push arbitrary transactions through Settu.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { CCTP_CONFIG } from "../cctp/constants";
import { bridgeContractFor } from "./contracts";

export class SubmitStellarError extends Error {
  readonly code: "invalid_tx" | "not_a_bridge" | "rejected" | "failed" | "unavailable";
  constructor(code: SubmitStellarError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "SubmitStellarError";
  }
}

export interface SubmitStellarDeps {
  passphrase(): string;
  bridgeContract(): string;
  send(xdr: string): Promise<{ hash: string; status: string }>;
  getStatus(hash: string): Promise<string>;
  sleep(ms: number): Promise<void>;
}

const POLL_MS = 1_500;
const POLL_ATTEMPTS = 20; // ~30 s

function assertBridgeCall(xdr: string, d: SubmitStellarDeps): void {
  let tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction;
  try {
    tx = StellarSdk.TransactionBuilder.fromXDR(xdr, d.passphrase());
  } catch {
    throw new SubmitStellarError("invalid_tx", "That isn't a valid Stellar transaction.");
  }
  const inner = tx instanceof StellarSdk.FeeBumpTransaction ? tx.innerTransaction : tx;
  const op = inner.operations.length === 1 ? inner.operations[0] : undefined;
  let ok = false;
  if (op && op.type === "invokeHostFunction") {
    const fn = op.func;
    if (fn.switch() === StellarSdk.xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
      const call = fn.invokeContract();
      const contract = StellarSdk.Address.fromScAddress(call.contractAddress()).toString();
      ok = contract === d.bridgeContract() && call.functionName().toString() === "bridge";
    }
  }
  if (!ok) throw new SubmitStellarError("not_a_bridge", "Only Settu bridge transactions can be submitted here.");
}

export async function submitStellarBridgeTx(
  signedXdr: string,
  d: SubmitStellarDeps = defaultSubmitStellarDeps(),
): Promise<{ hash: string }> {
  assertBridgeCall(signedXdr, d);
  const sent = await d.send(signedXdr);
  if (sent.status === "ERROR") {
    throw new SubmitStellarError("rejected", "The Stellar network rejected the transaction. Nothing was sent.");
  }
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const status = await d.getStatus(sent.hash);
    if (status === "SUCCESS") return { hash: sent.hash };
    if (status === "FAILED") {
      throw new SubmitStellarError("failed", "The bridge transaction failed on Stellar. Your USDC didn't move.");
    }
    await d.sleep(POLL_MS);
  }
  // Still pending: it may yet land, and the event sweep registers it if so.
  return { hash: sent.hash };
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(CCTP_CONFIG.stellarRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!res.ok) throw new SubmitStellarError("unavailable", `Soroban RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error || !json.result) {
    throw new SubmitStellarError("unavailable", `Soroban ${method} failed: ${json.error?.message ?? "no result"}`);
  }
  return json.result;
}

export function defaultSubmitStellarDeps(): SubmitStellarDeps {
  return {
    passphrase: () => CCTP_CONFIG.stellarNetworkPassphrase,
    bridgeContract: () => bridgeContractFor("stellar"),
    send: (xdr) => rpc<{ hash: string; status: string }>("sendTransaction", { transaction: xdr }),
    getStatus: async (hash) => (await rpc<{ status: string }>("getTransaction", { hash })).status,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
