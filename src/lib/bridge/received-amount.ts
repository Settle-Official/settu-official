/**
 * The USDC a bridge actually delivered, read from its destination mint
 * transaction and stored as BridgeMeta.receivedAtomic (6-dp atomic).
 *
 * - EVM: the USDC `Transfer` mint (from 0x0) to the mint recipient. The fee
 *   mint to Circle's fee recipient in the same tx is excluded.
 * - Solana: post − pre USDC balance of the recipient ATA (the mint recipient).
 * - Stellar (CCTP Forwarder): the USDC `transfer` the Forwarder made to the
 *   user — what the user got, not what was minted to the Forwarder — scaled
 *   from Stellar's 7 dp to 6 dp.
 *
 * A destination tx that failed on-chain throws MintTxFailedError, so the
 * caller can go back and mint again. All chain reads are injectable.
 */

import { createPublicClient, http, type Hex } from "viem";
import { Connection, PublicKey } from "@solana/web3.js";
import * as StellarSdk from "@stellar/stellar-sdk";
import { xdr } from "@stellar/stellar-sdk";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";
import { CCTP_CONFIG } from "../cctp/constants";
import { requireSolanaRpcUrl } from "../solana/config";

export class MintTxFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MintTxFailedError";
  }
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = `0x${"0".repeat(64)}`;

export interface EvmReceipt {
  status: string;
  logs: { address: string; topics: readonly string[]; data: string }[];
}

export interface SolanaTxView {
  err: unknown;
  /** All account keys, lookup-table addresses included, in index order. */
  accountKeys: string[];
  preTokenBalances: { accountIndex: number; mint: string; amount: string }[];
  postTokenBalances: { accountIndex: number; mint: string; amount: string }[];
}

export interface StellarTxView {
  status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  events: { contractId: string; topics: xdr.ScVal[]; data: xdr.ScVal }[];
}

export interface ReceivedAmountDeps {
  evmReceipt(chain: BridgeChainKey, hash: string): Promise<EvmReceipt>;
  solanaTx(signature: string): Promise<SolanaTxView | null>;
  stellarTx(hash: string): Promise<StellarTxView>;
}

function evmReceived(r: EvmReceipt, usdc: string, mintRecipient: string): bigint {
  if (r.status !== "success") throw new MintTxFailedError(`EVM mint tx status ${r.status}`);
  const to = `0x${mintRecipient.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
  let total = BigInt(0);
  let found = false;
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== usdc.toLowerCase()) continue;
    const [t0, from, dst] = log.topics.map((t) => t.toLowerCase());
    if (t0 !== TRANSFER_TOPIC || from !== ZERO_TOPIC || dst !== to) continue;
    total += BigInt(log.data);
    found = true;
  }
  if (!found) throw new Error("no USDC mint to the recipient in the destination tx");
  return total;
}

function solanaReceived(tx: SolanaTxView | null, ata: string, mint: string): bigint {
  if (!tx) throw new Error("Solana mint tx not found yet");
  if (tx.err) throw new MintTxFailedError(`Solana mint tx failed: ${JSON.stringify(tx.err)}`);
  const index = tx.accountKeys.indexOf(ata);
  if (index < 0) throw new Error("recipient ATA not in the destination tx");
  const bal = (list: SolanaTxView["preTokenBalances"]) =>
    BigInt(list.find((b) => b.accountIndex === index && b.mint === mint)?.amount ?? "0");
  return bal(tx.postTokenBalances) - bal(tx.preTokenBalances);
}

function scvAddress(v: xdr.ScVal): string | null {
  try {
    return StellarSdk.Address.fromScVal(v).toString();
  } catch {
    return null;
  }
}

/** SAC transfer data: i128, or (CAP-67) a map with an `amount` field. */
function transferAmount(data: xdr.ScVal): bigint {
  if (data.switch().name === "scvMap") {
    const entry = data.map()?.find((e) => e.key().switch().name === "scvSymbol" && e.key().sym().toString() === "amount");
    if (!entry) throw new Error("transfer event without an amount");
    return BigInt(StellarSdk.scValToNative(entry.val()));
  }
  return BigInt(StellarSdk.scValToNative(data));
}

function stellarReceived(tx: StellarTxView): bigint {
  if (tx.status === "FAILED") throw new MintTxFailedError("Stellar mint_and_forward tx failed");
  if (tx.status !== "SUCCESS") throw new Error("Stellar mint tx not found yet");
  let total = BigInt(0);
  let found = false;
  for (const e of tx.events) {
    if (e.contractId !== CCTP_CONFIG.stellarUsdc) continue;
    const [name, from] = e.topics;
    if (name?.switch().name !== "scvSymbol" || name.sym().toString() !== "transfer") continue;
    if (!from || scvAddress(from) !== CCTP_CONFIG.stellarCctpForwarder) continue;
    total += transferAmount(e.data);
    found = true;
  }
  if (!found) throw new Error("no Forwarder transfer to the user in the destination tx");
  return total / BigInt(10); // 7 dp → 6 dp
}

export async function readReceivedAtomic(
  dest: BridgeChainKey,
  mintTx: string,
  ctx: { mintRecipient: string },
  deps: ReceivedAmountDeps = defaultReceivedAmountDeps,
): Promise<bigint> {
  const chain = BRIDGE_CHAINS[dest];
  switch (chain.family) {
    case "evm":
      return evmReceived(await deps.evmReceipt(dest, mintTx), chain.usdc, ctx.mintRecipient);
    case "solana": {
      const ata = new PublicKey(Buffer.from(ctx.mintRecipient.replace(/^0x/i, ""), "hex")).toBase58();
      return solanaReceived(await deps.solanaTx(mintTx), ata, chain.usdc);
    }
    case "stellar":
      return stellarReceived(await deps.stellarTx(mintTx));
  }
}

export const defaultReceivedAmountDeps: ReceivedAmountDeps = {
  async evmReceipt(chain, hash) {
    const rpcVar = BRIDGE_CHAINS[chain].rpcEnvVar;
    const rpc = process.env[rpcVar];
    if (!rpc) throw new Error(`${rpcVar} not configured`);
    const r = await createPublicClient({ transport: http(rpc) }).getTransactionReceipt({ hash: hash as Hex });
    return { status: r.status, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) };
  },
  async solanaTx(signature) {
    const conn = new Connection(requireSolanaRpcUrl(), "confirmed");
    const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx?.meta) return null;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    const accountKeys: string[] = [];
    for (let i = 0; i < keys.length; i++) accountKeys.push(keys.get(i)!.toBase58());
    const view = (list: typeof tx.meta.preTokenBalances) =>
      (list ?? []).map((b) => ({ accountIndex: b.accountIndex, mint: b.mint, amount: b.uiTokenAmount.amount }));
    return {
      err: tx.meta.err,
      accountKeys,
      preTokenBalances: view(tx.meta.preTokenBalances),
      postTokenBalances: view(tx.meta.postTokenBalances),
    };
  },
  async stellarTx(hash) {
    const server = new StellarSdk.rpc.Server(CCTP_CONFIG.stellarRpcUrl);
    const res = await server.getTransaction(hash);
    if (res.status === StellarSdk.rpc.Api.GetTransactionStatus.NOT_FOUND) return { status: "NOT_FOUND", events: [] };
    const events = (res.events?.contractEventsXdr ?? []).flat().flatMap((e) => {
      const id = e.contractId();
      if (!id) return [];
      const body = e.body().v0();
      return [{ contractId: StellarSdk.StrKey.encodeContract(Buffer.from(id as unknown as Uint8Array)), topics: body.topics(), data: body.data() }];
    });
    return { status: res.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS ? "SUCCESS" : "FAILED", events };
  },
};
