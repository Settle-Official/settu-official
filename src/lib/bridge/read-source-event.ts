/**
 * Reads the `Bridged` event our bridge contract emitted in a source tx.
 * Only events from `bridgeContractFor(chain)` count. Chain reads go through
 * injectable deps so tests never touch the network.
 *
 * Amounts are returned in 6-decimal USDC atomic units (Stellar's 7-decimal
 * values are divided by 10, asserting divisibility; Solana is already 6).
 *
 * Solana: the `Bridged` event is an Anchor `emit!`, i.e. a `Program data:`
 * log line. Only lines logged inside OUR program's own invocation frame
 * count (the frame stack is rebuilt from the runtime's `invoke` / `success`
 * / `failed` lines, which programs cannot forge: their `msg!` output is
 * always prefixed `Program log:`).
 */

import { createPublicClient, decodeEventLog, http, parseAbiItem, type Hex } from "viem";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";
import { bridgeContractFor } from "./contracts";
import { sorobanRpc } from "../stellar/soroban-rpc";
import { Connection, PublicKey } from "@solana/web3.js";
import { requireSolanaRpcUrl } from "../solana/config";
import { settuBridgeCoder } from "../solana/settu-bridge";

/** The tx isn't visible on the node yet (retryable). */
export class TxNotIndexedError extends Error {
  constructor() {
    super("transaction not indexed yet");
    this.name = "TxNotIndexedError";
  }
}

/** The tx's event is malformed (permanent). */
export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEventError";
  }
}

export interface BridgedEvent {
  nonce: Hex;
  /** Source-chain address in native form (0x…, G… or base58). */
  user: string;
  amount: bigint;
  settuFee: bigint;
  networkFee: bigint;
  /** Source-native units (wei/stroops/lamports). */
  nativeFee: bigint;
  destDomain: number;
  mintRecipient: Hex;
  minFinality: number;
}

export interface EvmLogLike {
  address: string;
  topics: readonly Hex[];
  data: Hex;
}

export interface ReadEventDeps {
  /** Logs of a successful tx; null if it reverted; throws TxNotIndexedError if not found. */
  evmLogs(chain: BridgeChainKey, txHash: string): Promise<EvmLogLike[] | null>;
  /** Contract events of a successful Soroban tx; null if it failed; throws TxNotIndexedError if not found. */
  stellarEvents(txHash: string): Promise<xdr.ContractEvent[] | null>;
  /** Log messages of a successful Solana tx; null if it failed; throws TxNotIndexedError if not found. */
  solanaLogs(signature: string): Promise<string[] | null>;
}

const BRIDGED_ABI = parseAbiItem(
  "event Bridged(bytes32 indexed nonce, address indexed user, uint256 amount, uint256 settuFee, uint256 networkFee, uint256 nativeFee, uint32 destDomain, bytes32 mintRecipient, uint32 minFinality)",
);

export function decodeEvmBridged(logs: EvmLogLike[], contract: string): BridgedEvent | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    try {
      const d = decodeEventLog({
        abi: [BRIDGED_ABI],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (d.eventName !== "Bridged") continue;
      const a = d.args;
      return {
        nonce: a.nonce,
        user: a.user,
        amount: a.amount,
        settuFee: a.settuFee,
        networkFee: a.networkFee,
        nativeFee: a.nativeFee,
        destDomain: a.destDomain,
        mintRecipient: a.mintRecipient,
        minFinality: a.minFinality,
      };
    } catch {
      // Another event from our contract — keep looking.
    }
  }
  return null;
}

function to6(v: bigint, what: string): bigint {
  if (v % BigInt(10) !== BigInt(0)) throw new InvalidEventError(`Stellar ${what} ${v} is not divisible by 10 (7 -> 6 decimals)`);
  return v / BigInt(10);
}

const hex = (b: Uint8Array | Buffer): Hex => `0x${Buffer.from(b).toString("hex")}` as Hex;

export function decodeStellarBridged(
  events: xdr.ContractEvent[],
  contractId: string,
): BridgedEvent | null {
  for (const e of events) {
    const id = e.contractId();
    if (!id) continue;
    if (Address.contract(Buffer.from(id as unknown as Uint8Array)).toString() !== contractId) continue;
    if (e.type() !== xdr.ContractEventType.contract()) continue;
    const body = e.body().v0();
    const topics = body.topics();
    if (topics.length < 2) continue;
    if (topics[0].switch().name !== "scvSymbol" || topics[0].sym().toString() !== "bridged") continue;
    const data = scValToNative(body.data()) as unknown[];
    if (!Array.isArray(data) || data.length !== 8) continue;
    const [user, amount, settuFee, networkFee, nativeFee, destDomain, mintRecipient, minFinality] = data;
    return {
      nonce: hex(topics[1].bytes()),
      user: String(user),
      amount: to6(BigInt(amount as bigint), "amount"),
      settuFee: to6(BigInt(settuFee as bigint), "settuFee"),
      networkFee: to6(BigInt(networkFee as bigint), "networkFee"),
      nativeFee: BigInt(nativeFee as bigint),
      destDomain: Number(destDomain),
      mintRecipient: hex(mintRecipient as Uint8Array),
      minFinality: Number(minFinality),
    };
  }
  return null;
}

/** Contract events from a getTransaction `resultMetaXdr` (meta v3 and v4). */
export function stellarContractEvents(resultMetaXdr: string): xdr.ContractEvent[] {
  const meta = xdr.TransactionMeta.fromXDR(resultMetaXdr, "base64");
  const out: xdr.ContractEvent[] = [];
  const sw = meta.switch();
  if (sw === 3) {
    const sm = meta.v3().sorobanMeta();
    if (sm) out.push(...sm.events());
  } else if (sw === 4) {
    for (const op of meta.v4().operations()) out.push(...op.events());
  }
  return out;
}

// ---------------------------------------------------------------- Solana

const B58 = "[1-9A-HJ-NP-Za-km-z]{32,44}";
const INVOKE_RE = new RegExp(`^Program (${B58}) invoke \\[\\d+\\]$`);
const EXIT_RE = new RegExp(`^Program (${B58}) (?:success$|failed)`);
const DATA_PREFIX = "Program data: ";

function bnToBigint(v: unknown, what: string): bigint {
  const s = (v as { toString(): string } | null)?.toString();
  if (typeof s !== "string" || !/^\d+$/.test(s)) throw new InvalidEventError(`Solana Bridged ${what} is not an integer`);
  return BigInt(s);
}

function bytes32(v: unknown, what: string): Hex {
  if (!Array.isArray(v) || v.length !== 32) throw new InvalidEventError(`Solana Bridged ${what} is not 32 bytes`);
  return hex(Uint8Array.from(v as number[]));
}

/** The `Bridged` event logged inside `programId`'s own frame, or null. */
export function decodeSolanaBridged(logs: string[], programId: string): BridgedEvent | null {
  const stack: string[] = [];
  for (const line of logs) {
    const inv = INVOKE_RE.exec(line);
    if (inv) {
      stack.push(inv[1]);
      continue;
    }
    if (EXIT_RE.test(line)) {
      stack.pop();
      continue;
    }
    if (!line.startsWith(DATA_PREFIX) || stack[stack.length - 1] !== programId) continue;
    let decoded: { name: string; data: Record<string, unknown> } | null;
    try {
      decoded = settuBridgeCoder.events.decode(line.slice(DATA_PREFIX.length)) as typeof decoded;
    } catch {
      // Discriminator matched but the body doesn't decode.
      throw new InvalidEventError("Solana Bridged event does not decode");
    }
    if (!decoded || decoded.name !== "Bridged") continue;
    const d = decoded.data;
    if (!(d.user instanceof PublicKey)) throw new InvalidEventError("Solana Bridged user is not a public key");
    return {
      nonce: bytes32(d.nonce, "nonce"),
      user: d.user.toBase58(),
      amount: bnToBigint(d.amount, "amount"),
      settuFee: bnToBigint(d.settu_fee, "settu_fee"),
      networkFee: bnToBigint(d.network_fee, "network_fee"),
      nativeFee: bnToBigint(d.native_fee, "native_fee"),
      destDomain: Number(d.dest_domain),
      mintRecipient: bytes32(d.mint_recipient, "mint_recipient"),
      minFinality: Number(d.min_finality),
    };
  }
  return null;
}

/** The subset of Connection the default Solana reader uses. */
export interface SolanaTxReader {
  getTransaction(
    signature: string,
    opts: { maxSupportedTransactionVersion: number; commitment: "confirmed" },
  ): Promise<{ meta: { err: unknown; logMessages?: string[] | null } | null } | null>;
}

/** Logs of a successful tx; null if it failed; TxNotIndexedError if the node doesn't have it. */
export async function solanaTxLogs(conn: SolanaTxReader, signature: string): Promise<string[] | null> {
  const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) throw new TxNotIndexedError();
  if (!tx.meta || tx.meta.err !== null) return null;
  return tx.meta.logMessages ?? [];
}

export const defaultReadEventDeps: ReadEventDeps = {
  async evmLogs(chain, txHash) {
    const url = process.env[BRIDGE_CHAINS[chain].rpcEnvVar];
    if (!url) throw new Error(`${BRIDGE_CHAINS[chain].rpcEnvVar} is not set`);
    const client = createPublicClient({ transport: http(url) });
    try {
      const r = await client.getTransactionReceipt({ hash: txHash as Hex });
      if (r.status !== "success") return null;
      return r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data }));
    } catch (e) {
      if (e instanceof Error && e.name === "TransactionReceiptNotFoundError") throw new TxNotIndexedError();
      throw e;
    }
  },
  async stellarEvents(txHash) {
    const res = await sorobanRpc("getTransaction", { hash: txHash });
    if (res?.status === "NOT_FOUND") throw new TxNotIndexedError();
    if (res?.status !== "SUCCESS" || !res.resultMetaXdr) return null;
    return stellarContractEvents(res.resultMetaXdr);
  },
  solanaLogs: (signature) =>
    solanaTxLogs(new Connection(requireSolanaRpcUrl(), "confirmed") as unknown as SolanaTxReader, signature),
};

export async function readBridgedEvent(
  chain: BridgeChainKey,
  txHash: string,
  deps: ReadEventDeps = defaultReadEventDeps,
): Promise<BridgedEvent | null> {
  switch (BRIDGE_CHAINS[chain].family) {
    case "evm": {
      const logs = await deps.evmLogs(chain, txHash);
      return logs ? decodeEvmBridged(logs, bridgeContractFor(chain)) : null;
    }
    case "stellar": {
      const events = await deps.stellarEvents(txHash);
      return events ? decodeStellarBridged(events, bridgeContractFor(chain)) : null;
    }
    case "solana": {
      const logs = await deps.solanaLogs(txHash);
      return logs ? decodeSolanaBridged(logs, bridgeContractFor(chain)) : null;
    }
  }
}
