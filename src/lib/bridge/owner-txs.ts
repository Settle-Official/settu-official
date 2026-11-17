/**
 * Owner-signed limit changes for the Settu bridge contracts (spec §5), and
 * the live reads behind the admin "limits" panel.
 *
 * The server only BUILDS these transactions. They are returned unsigned for
 * the owner wallet connected in the admin's browser to sign; no owner key
 * ever exists server-side. That is the point of the cap: a stolen
 * quote-signing key must not be able to raise it.
 *
 * - EVM: calldata for SettuBridge.setMaxFeeBps / setMaxNetworkFee /
 *   setMaxNativeFee (contracts/evm/src/SettuBridge.sol), `{ to, data, chainId }`.
 * - Stellar: a simulated + assembled invoke of settu-bridge set_max_fee_bps(u32)
 *   / set_max_network_fee(i128) / set_max_native_fee(i128), with the owner as
 *   the transaction source so `owner.require_auth()` is the envelope signature.
 * - Solana: the program isn't available yet; reads and builds say so.
 *
 * A chain whose BRIDGE_CONTRACT_<CHAIN> is unset is "not deployed": skipped,
 * never an RPC call, never a throw.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { xdr } from "@stellar/stellar-sdk";
import { createPublicClient, encodeFunctionData, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { CCTP_CONFIG } from "../cctp/constants";
import { buildAndAssemble, BuildTxError, type StellarRpcLike } from "./build-source-tx";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";
import { bridgeContractFor } from "./contracts";
import { getBridgeFeeBps } from "./fee-settings";
import type { Speed } from "./quote-math";

export type OwnerLimit = "maxFeeBps" | "maxNetworkFee" | "maxNativeFee";
export const OWNER_LIMITS: readonly OwnerLimit[] = ["maxFeeBps", "maxNetworkFee", "maxNativeFee"];

export type OwnerTx =
  | { family: "evm"; chainId: number; to: Address; data: Hex }
  | { family: "stellar"; xdr: string };

export class OwnerTxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OwnerTxError";
  }
}

export const SOLANA_NOT_AVAILABLE = "The Solana bridge program is not available yet.";
export const CAP_BELOW_FEE = "Lower the bridge fee first";

/** Hand-written from contracts/evm/src/SettuBridge.sol. */
export const OWNER_LIMITS_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "maxFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxNetworkFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxNativeFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "setMaxFeeBps",
    stateMutability: "nonpayable",
    inputs: [{ name: "maxFeeBps_", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setMaxNetworkFee",
    stateMutability: "nonpayable",
    inputs: [{ name: "maxNetworkFee_", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setMaxNativeFee",
    stateMutability: "nonpayable",
    inputs: [{ name: "maxNativeFee_", type: "uint256" }],
    outputs: [],
  },
] as const;

const EVM_SETTER = {
  maxFeeBps: "setMaxFeeBps",
  maxNetworkFee: "setMaxNetworkFee",
  maxNativeFee: "setMaxNativeFee",
} as const;

/** contracts/stellar/settu-bridge/src/lib.rs */
const STELLAR_SETTER: Record<OwnerLimit, string> = {
  maxFeeBps: "set_max_fee_bps",
  maxNetworkFee: "set_max_network_fee",
  maxNativeFee: "set_max_native_fee",
};
const STELLAR_GETTER: Record<OwnerLimit, string> = {
  maxFeeBps: "max_fee_bps",
  maxNetworkFee: "max_network_fee",
  maxNativeFee: "max_native_fee",
};

const BPS_DENOMINATOR = BigInt(10_000);
const ZERO = BigInt(0);
const U256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);
const I128_MAX = (BigInt(1) << BigInt(127)) - BigInt(1);

export interface OwnerTxDeps {
  /** The chain's bridge contract, or null when not deployed (env unset). Throws when misconfigured. */
  contractFor(chain: BridgeChainKey): string | null;
  getFeeBps(speed: Speed): Promise<number>;
  readOwner(chain: BridgeChainKey, contract: string): Promise<string>;
  readLimit(chain: BridgeChainKey, contract: string, limit: OwnerLimit): Promise<bigint>;
  stellarServer(): StellarRpcLike;
}

// ---------------------------------------------------------------- reads

export type ChainLimitsRow =
  | {
      chain: BridgeChainKey;
      status: "ok";
      contract?: string;
      maxFeeBps: bigint;
      maxNetworkFee: bigint;
      maxNativeFee: bigint;
    }
  | { chain: BridgeChainKey; status: "not_deployed" }
  | { chain: BridgeChainKey; status: "not_available"; message: string }
  | { chain: BridgeChainKey; status: "error"; contract?: string; error: string };

export async function readChainLimits(
  chain: BridgeChainKey,
  overrides: Partial<OwnerTxDeps> = {},
): Promise<ChainLimitsRow> {
  const d = withDefaults(overrides);
  if (BRIDGE_CHAINS[chain].family === "solana") {
    return { chain, status: "not_available", message: SOLANA_NOT_AVAILABLE };
  }
  let contract: string | null;
  try {
    contract = d.contractFor(chain);
  } catch (e) {
    return { chain, status: "error", error: errMessage(e, "Contract address is misconfigured.") };
  }
  if (!contract) return { chain, status: "not_deployed" };
  try {
    const [maxFeeBps, maxNetworkFee, maxNativeFee] = await Promise.all(
      OWNER_LIMITS.map((l) => d.readLimit(chain, contract, l)),
    );
    return { chain, status: "ok", contract, maxFeeBps, maxNetworkFee, maxNativeFee };
  } catch (e) {
    console.error(`[bridge/owner-txs] limit read failed on ${chain}:`, errMessage(e, "unknown"));
    return { chain, status: "error", contract, error: "Couldn't read this contract right now." };
  }
}

/** All 8 chains, in registry order. Never throws. */
export async function readAllLimits(overrides: Partial<OwnerTxDeps> = {}): Promise<ChainLimitsRow[]> {
  const chains = Object.keys(BRIDGE_CHAINS) as BridgeChainKey[];
  return Promise.all(chains.map((c) => readChainLimits(c, overrides)));
}

/**
 * Lowest maxFeeBps across deployed chains. `undefined` when none is deployed
 * (the caller falls back to the env cap); `null` when a deployed chain
 * couldn't be read, so the lowest is unknown and the caller must fail closed.
 */
export function lowestDeployedCapBps(rows: readonly ChainLimitsRow[]): number | null | undefined {
  if (rows.some((r) => r.status === "error")) return null;
  const caps = rows.flatMap((r) => (r.status === "ok" ? [Number(r.maxFeeBps)] : []));
  return caps.length ? Math.min(...caps) : undefined;
}

// ---------------------------------------------------------------- build

export async function buildSetLimitTx(
  chain: BridgeChainKey,
  limit: OwnerLimit,
  value: bigint,
  ownerAddress: string,
  overrides: Partial<OwnerTxDeps> = {},
): Promise<OwnerTx> {
  const d = withDefaults(overrides);
  const c = BRIDGE_CHAINS[chain];
  if (!c) throw new OwnerTxError("invalid_request", "Unknown chain.");
  if (!OWNER_LIMITS.includes(limit)) throw new OwnerTxError("invalid_request", "Unknown limit.");
  if (c.family === "solana") throw new OwnerTxError("not_available", SOLANA_NOT_AVAILABLE);

  const max = limit === "maxFeeBps" ? BPS_DENOMINATOR : c.family === "evm" ? U256_MAX : I128_MAX;
  if (typeof value !== "bigint" || value < ZERO || value > max) {
    throw new OwnerTxError(
      "invalid_value",
      limit === "maxFeeBps" ? "The cap must be between 0 and 10000 bps." : "That limit value is out of range.",
    );
  }

  let contract: string | null;
  try {
    contract = d.contractFor(chain);
  } catch {
    throw new OwnerTxError("misconfigured", `${c.label}'s bridge contract address is misconfigured.`);
  }
  if (!contract) throw new OwnerTxError("not_deployed", `The ${c.label} bridge contract is not deployed.`);

  if (c.family === "evm") {
    if (!isAddress(ownerAddress, { strict: false })) {
      throw new OwnerTxError("invalid_owner", "Connect an EVM wallet.");
    }
  } else if (!StellarSdk.StrKey.isValidEd25519PublicKey(ownerAddress)) {
    throw new OwnerTxError("invalid_owner", "Connect a Stellar wallet.");
  }

  if (limit === "maxFeeBps") {
    const [standard, fast] = await Promise.all([d.getFeeBps("standard"), d.getFeeBps("fast")]);
    if (value < BigInt(Math.max(standard, fast))) {
      throw new OwnerTxError("cap_below_fee", CAP_BELOW_FEE);
    }
  }

  const owner = await d.readOwner(chain, contract);
  const isOwner =
    c.family === "evm"
      ? isAddress(owner, { strict: false }) && getAddress(owner) === getAddress(ownerAddress)
      : owner === ownerAddress;
  if (!isOwner) {
    throw new OwnerTxError("not_owner", `The connected wallet is not the owner of the ${c.label} bridge contract.`);
  }

  if (c.family === "evm") {
    if (!c.chainId) throw new Error(`internal: no chainId for ${chain}`);
    return {
      family: "evm",
      chainId: c.chainId,
      to: getAddress(contract),
      data: encodeFunctionData({ abi: OWNER_LIMITS_ABI, functionName: EVM_SETTER[limit], args: [value] }),
    };
  }

  const arg =
    limit === "maxFeeBps"
      ? xdr.ScVal.scvU32(Number(value))
      : StellarSdk.nativeToScVal(value, { type: "i128" });
  const server = d.stellarServer();
  const account = await server.getAccount(ownerAddress);
  const op = new StellarSdk.Contract(contract).call(STELLAR_SETTER[limit], arg);
  try {
    return {
      family: "stellar",
      xdr: await buildAndAssemble(server, account, op, "This limit change can't be prepared (simulation failed)."),
    };
  } catch (e) {
    if (e instanceof BuildTxError) throw new OwnerTxError(e.code, e.message);
    throw e;
  }
}

// ---------------------------------------------------------------- defaults

const RPC_TIMEOUT_MS = 8_000;

function errMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

function evmClient(chain: BridgeChainKey) {
  const envVar = BRIDGE_CHAINS[chain].rpcEnvVar;
  const rpc = process.env[envVar];
  if (!rpc) throw new Error(`${envVar} is not set`);
  return createPublicClient({ transport: http(rpc, { timeout: RPC_TIMEOUT_MS }) });
}

/** Read-only Soroban view call, simulated from the null account. */
async function stellarView(server: StellarRpcLike, contract: string, fn: string): Promise<unknown> {
  const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(StellarSdk.contract.NULL_ACCOUNT, "0"), {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: CCTP_CONFIG.stellarNetworkPassphrase,
  })
    .addOperation(new StellarSdk.Contract(contract).call(fn))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${fn}`);
  const retval = (sim as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) throw new Error(`no return value: ${fn}`);
  return StellarSdk.scValToNative(retval);
}

function toBigint(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  throw new Error("unexpected limit value");
}

/** BRIDGE_CONTRACT_<CHAIN> unset → null (not deployed); malformed → throws. */
function envContractFor(chain: BridgeChainKey): string | null {
  if (!process.env[`BRIDGE_CONTRACT_${chain.toUpperCase()}`]?.trim()) return null;
  return bridgeContractFor(chain);
}

export function defaultOwnerTxDeps(): OwnerTxDeps {
  const stellarServer = () => new StellarSdk.rpc.Server(CCTP_CONFIG.stellarRpcUrl);
  return {
    contractFor: envContractFor,
    getFeeBps: (speed) => getBridgeFeeBps(speed),
    stellarServer,
    async readOwner(chain, contract) {
      if (BRIDGE_CHAINS[chain].family === "evm") {
        return evmClient(chain).readContract({
          address: getAddress(contract),
          abi: OWNER_LIMITS_ABI,
          functionName: "owner",
        });
      }
      return String(await stellarView(stellarServer(), contract, "owner"));
    },
    async readLimit(chain, contract, limit) {
      if (BRIDGE_CHAINS[chain].family === "evm") {
        return evmClient(chain).readContract({
          address: getAddress(contract),
          abi: OWNER_LIMITS_ABI,
          functionName: limit,
        });
      }
      return toBigint(await stellarView(stellarServer(), contract, STELLAR_GETTER[limit]));
    },
  };
}

function withDefaults(overrides: Partial<OwnerTxDeps>): OwnerTxDeps {
  const given = Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v !== undefined),
  ) as Partial<OwnerTxDeps>;
  return { ...defaultOwnerTxDeps(), ...given };
}
