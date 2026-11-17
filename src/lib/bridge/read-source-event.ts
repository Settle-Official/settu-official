/**
 * Reads the `Bridged` event our bridge contract emitted in a source tx.
 * Only events from `bridgeContractFor(chain)` count. Chain reads go through
 * injectable deps so tests never touch the network.
 *
 * Amounts are returned in 6-decimal USDC atomic units (Stellar's 7-decimal
 * values are divided by 10, asserting divisibility). Solana sources land with
 * Task 8.
 */

import { createPublicClient, decodeEventLog, http, parseAbiItem, type Hex } from "viem";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";
import { bridgeContractFor } from "./contracts";
import { sorobanRpc } from "../stellar/soroban-rpc";

export interface BridgedEvent {
  nonce: Hex;
  /** Source-chain address in native form (0x… or G…). */
  user: string;
  amount: bigint;
  settuFee: bigint;
  networkFee: bigint;
  /** Source-native units (wei/stroops). */
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
  /** Logs of a successful tx, or null if not found / reverted. */
  evmLogs(chain: BridgeChainKey, txHash: string): Promise<EvmLogLike[] | null>;
  /** Contract events of a successful Soroban tx, or null if not found / failed. */
  stellarEvents(txHash: string): Promise<xdr.ContractEvent[] | null>;
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
  if (v % BigInt(10) !== BigInt(0)) throw new Error(`Stellar ${what} ${v} is not divisible by 10 (7 -> 6 decimals)`);
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
      if (e instanceof Error && e.name === "TransactionReceiptNotFoundError") return null;
      throw e;
    }
  },
  async stellarEvents(txHash) {
    const res = await sorobanRpc("getTransaction", { hash: txHash });
    if (res?.status !== "SUCCESS" || !res.resultMetaXdr) return null;
    return stellarContractEvents(res.resultMetaXdr);
  },
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
    case "solana":
      throw new Error("solana source not supported yet");
  }
}
