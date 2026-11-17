/**
 * Source-chain transaction builders for the user bridge (spec §9). Given a
 * signed quote from /api/bridge/quote, build the UNSIGNED transaction the
 * user's wallet signs: a call to Settu's bridge contract on the source chain
 * carrying exactly the signed quote + signature. The contract verifies the
 * signature, so anything altered here would be rejected on-chain; we still
 * validate every field so a tampered or stale quote fails fast with a 400.
 *
 * - EVM: calldata for SettuBridge.bridge(Quote, sig, Permit), value = nativeFee.
 * - Stellar: simulated + assembled invoke of settu-bridge `bridge`, as XDR.
 * - Solana: not built here; the Solana source builder ships with the Solana
 *   program in Task 8.
 *
 * The quote body arrives from the client, so it is untrusted input.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { xdr } from "@stellar/stellar-sdk";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { CCTP_CONFIG } from "../cctp/constants";
import type { QuoteResponse, QuoteSuccess, SerializedBridgeQuote } from "./build-quote";
import { BRIDGE_CHAINS, bridgeChainByDomain, type BridgeChainKey } from "./chains";
import { bridgeContractFor as envBridgeContractFor } from "./contracts";

// ---------------------------------------------------------------- types

/** EIP-2612 permit signature from the client (uint256 values as decimal strings). */
export interface PermitSig {
  value: string;
  deadline: string;
  v: number;
  r: Hex;
  s: Hex;
}

export type SourceTx =
  | {
      family: "evm";
      chainId: number;
      to: Address;
      data: Hex;
      /** Wei, decimal string; equals quote.nativeFee ("0" in usdc mode). */
      value: string;
      needsApproval: boolean;
    }
  | { family: "stellar"; xdr: string };

export class BuildTxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "BuildTxError";
  }
}

/** The subset of StellarSdk.rpc.Server this module uses (injectable in tests). */
export interface StellarRpcLike {
  getLatestLedger(): Promise<{ sequence: number }>;
  getAccount(address: string): Promise<StellarSdk.Account>;
  simulateTransaction(
    tx: StellarSdk.Transaction,
  ): Promise<StellarSdk.rpc.Api.SimulateTransactionResponse>;
}

export interface BuildSourceTxDeps {
  /** Unix seconds. */
  now(): number;
  bridgeContractFor(chain: BridgeChainKey): string;
  /** USDC allowance owner → spender on an EVM chain, in atomic units. */
  evmAllowance(chain: BridgeChainKey, owner: Address, spender: Address): Promise<bigint>;
  stellarServer(): StellarRpcLike;
}

// ---------------------------------------------------------------- EVM ABI

/**
 * Hand-written from contracts/evm/src/SettuBridge.sol. Component order is the
 * Solidity struct order (= EVM_QUOTE_TYPES). The test pins the selector to
 * `forge inspect SettuBridge methodIdentifiers`.
 */
export const BRIDGE_ABI = [
  {
    type: "function",
    name: "bridge",
    stateMutability: "payable",
    inputs: [
      {
        name: "q",
        type: "tuple",
        internalType: "struct SettuBridge.Quote",
        components: [
          { name: "version", type: "uint8" },
          { name: "sourceDomain", type: "uint32" },
          { name: "destDomain", type: "uint32" },
          { name: "user", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "settuFee", type: "uint256" },
          { name: "networkFee", type: "uint256" },
          { name: "nativeFee", type: "uint256" },
          { name: "mintRecipient", type: "bytes32" },
          { name: "hookData", type: "bytes" },
          { name: "maxFee", type: "uint256" },
          { name: "minFinality", type: "uint32" },
          { name: "deadline", type: "uint64" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      { name: "sig", type: "bytes" },
      {
        name: "p",
        type: "tuple",
        internalType: "struct SettuBridge.Permit",
        components: [
          { name: "value", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
          { name: "use", type: "bool" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

export const BRIDGE_FUNCTION_SIGNATURE =
  "bridge((uint8,uint32,uint32,address,uint256,uint256,uint256,uint256,bytes32,bytes,uint256,uint32,uint64,bytes32),bytes,(uint256,uint256,uint8,bytes32,bytes32,bool))";

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const NO_PERMIT = { value: BigInt(0), deadline: BigInt(0), v: 0, r: ZERO32, s: ZERO32, use: false };

// ---------------------------------------------------------------- validation

const ZERO = BigInt(0);
const TEN = BigInt(10);
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const U256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);

const INVALID_QUOTE = "This quote is invalid. Get a new quote and try again.";

function invalidQuote(): never {
  throw new BuildTxError("invalid_quote", INVALID_QUOTE);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function uintString(v: unknown, max: bigint): bigint {
  if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) invalidQuote();
  const n = BigInt(v);
  if (n > max) invalidQuote();
  return n;
}

function isHexBytes(v: unknown, len?: number): v is Hex {
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(v)) return false;
  return len === undefined || v.length === 2 + len * 2;
}

function u32(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffffffff) invalidQuote();
  return v;
}

interface ParsedQuote {
  raw: QuoteSuccess;
  q: SerializedBridgeQuote;
  source: BridgeChainKey;
  amount: bigint;
  settuFee: bigint;
  networkFee: bigint;
  nativeFee: bigint;
  maxFee: bigint;
}

/** Checks the shape of an untrusted QuoteResponse; returns parsed amounts. */
function parseQuote(input: QuoteResponse | unknown): ParsedQuote {
  if (!isRecord(input) || "error" in input) invalidQuote();
  const { quote, signature, expiresAt, contract } = input;
  if (!isRecord(quote) || typeof contract !== "string" || typeof signature !== "string") invalidQuote();
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)) invalidQuote();
  if (quote.version !== 1) invalidQuote();
  u32(quote.sourceDomain);
  u32(quote.destDomain);
  if (typeof quote.user !== "string") invalidQuote();
  if (!isHexBytes(quote.mintRecipient, 32) || !isHexBytes(quote.nonce, 32)) invalidQuote();
  if (!isHexBytes(quote.hookData)) invalidQuote();
  if (quote.minFinality !== 1000 && quote.minFinality !== 2000) invalidQuote();
  if (typeof quote.deadline !== "number" || !Number.isSafeInteger(quote.deadline) || quote.deadline < 0) {
    invalidQuote();
  }
  // The client-facing expiry must be the signed one.
  if (expiresAt !== quote.deadline) invalidQuote();

  let source: BridgeChainKey;
  try {
    source = bridgeChainByDomain(quote.sourceDomain as number).key;
  } catch {
    invalidQuote();
  }
  const family = BRIDGE_CHAINS[source].family;
  // EVM uint256; ed25519 layouts are u64.
  const max = family === "evm" ? U256_MAX : U64_MAX;
  const amount = uintString(quote.amount, max);
  const settuFee = uintString(quote.settuFee, max);
  const networkFee = uintString(quote.networkFee, max);
  const nativeFee = uintString(quote.nativeFee, max);
  const maxFee = uintString(quote.maxFee, max);
  if (amount === ZERO || settuFee + networkFee >= amount) invalidQuote();

  const sigLen = family === "evm" ? 65 : 64;
  if (!isHexBytes(signature, sigLen)) invalidQuote();

  return {
    raw: input as unknown as QuoteSuccess,
    q: quote as unknown as SerializedBridgeQuote,
    source,
    amount,
    settuFee,
    networkFee,
    nativeFee,
    maxFee,
  };
}

function parsePermit(p: unknown, amount: bigint) {
  const bad = (): never => {
    throw new BuildTxError("invalid_permit", "The USDC permit is invalid. Sign it again.");
  };
  if (!isRecord(p)) bad();
  const r = p as Record<string, unknown>;
  const num = (v: unknown) => {
    if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) bad();
    const n = BigInt(v as string);
    if (n > U256_MAX) bad();
    return n;
  };
  const value = num(r.value);
  const deadline = num(r.deadline);
  if (typeof r.v !== "number" || !Number.isInteger(r.v) || r.v < 0 || r.v > 255) bad();
  if (!isHexBytes(r.r, 32) || !isHexBytes(r.s, 32)) bad();
  // The contract pulls `amount` (fees + burn) from the user.
  if (value < amount) bad();
  return { value, deadline, v: r.v as number, r: r.r as Hex, s: r.s as Hex, use: true };
}

// ---------------------------------------------------------------- buildSourceTx

export async function buildSourceTx(
  input: QuoteResponse,
  userAddress: string,
  opts: { permit?: PermitSig } = {},
  overrides: Partial<BuildSourceTxDeps> = {},
): Promise<SourceTx> {
  const given = Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v !== undefined),
  ) as Partial<BuildSourceTxDeps>;
  const d: BuildSourceTxDeps = { ...defaultBuildSourceTxDeps(), ...given };

  if (typeof userAddress !== "string" || userAddress.length === 0) {
    throw new BuildTxError("invalid_request", "Invalid request.");
  }
  const p = parseQuote(input);
  const family = BRIDGE_CHAINS[p.source].family;

  if (family === "solana") {
    // The Solana source builder ships with the Solana bridge program (Task 8).
    throw new BuildTxError("unsupported_source", "Solana source not supported yet.");
  }

  if (Math.floor(d.now()) >= p.raw.expiresAt) {
    throw new BuildTxError("quote_expired", "This quote has expired. Get a new quote.");
  }

  const expected = d.bridgeContractFor(p.source);
  const sameContract =
    family === "evm"
      ? isAddress(p.raw.contract, { strict: false }) &&
        getAddress(p.raw.contract) === getAddress(expected)
      : p.raw.contract === expected;
  if (!sameContract) {
    throw new BuildTxError("contract_mismatch", INVALID_QUOTE);
  }

  return family === "evm" ? buildEvm(p, userAddress, opts.permit, expected as Address, d) : buildStellar(p, userAddress, expected, d);
}

async function buildEvm(
  p: ParsedQuote,
  userAddress: string,
  permit: PermitSig | undefined,
  contract: Address,
  d: BuildSourceTxDeps,
): Promise<SourceTx> {
  const chain = BRIDGE_CHAINS[p.source];
  if (!chain.chainId) throw new Error(`internal: no chainId for ${p.source}`);
  if (!isAddress(p.q.user, { strict: false })) invalidQuote();
  if (!isAddress(userAddress, { strict: false }) || getAddress(userAddress) !== getAddress(p.q.user)) {
    throw new BuildTxError("wrong_user", "This quote is for a different wallet.");
  }
  const user = getAddress(p.q.user);
  const permitArg = permit === undefined ? NO_PERMIT : parsePermit(permit, p.amount);

  const data = encodeFunctionData({
    abi: BRIDGE_ABI,
    functionName: "bridge",
    args: [
      {
        version: 1,
        sourceDomain: p.q.sourceDomain,
        destDomain: p.q.destDomain,
        user,
        amount: p.amount,
        settuFee: p.settuFee,
        networkFee: p.networkFee,
        nativeFee: p.nativeFee,
        mintRecipient: p.q.mintRecipient,
        hookData: p.q.hookData,
        maxFee: p.maxFee,
        minFinality: p.q.minFinality,
        deadline: BigInt(p.q.deadline),
        nonce: p.q.nonce,
      },
      p.raw.signature as Hex,
      permitArg,
    ],
  });

  let needsApproval = false;
  if (permit === undefined) {
    const allowance = await d.evmAllowance(p.source, user, contract);
    needsApproval = allowance < p.amount;
  }

  return {
    family: "evm",
    chainId: chain.chainId,
    to: contract,
    data,
    value: p.nativeFee.toString(),
    needsApproval,
  };
}

// ---------------------------------------------------------------- Stellar

/** approve_expiration_ledger = latest ledger + this (contract allows ≤ 1000). */
export const STELLAR_APPROVE_LEDGER_OFFSET = 100;
const STELLAR_TX_TIMEOUT_SEC = 180;
const AUTH_EXPIRATION_LEDGER_BUMP = 500;

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const bytes = (h: string) => xdr.ScVal.scvBytes(Buffer.from(h.replace(/^0x/, ""), "hex"));
const i128 = (n: bigint) => StellarSdk.nativeToScVal(n, { type: "i128" });

/**
 * settu-bridge `QuoteArgs` (#[contracttype] struct) as an ScMap. Soroban
 * requires the map keys sorted; for a struct they are the field-name symbols.
 */
export function quoteArgsScVal(p: ParsedQuote): xdr.ScVal {
  const fields: [string, xdr.ScVal][] = [
    ["source_domain", xdr.ScVal.scvU32(p.q.sourceDomain)],
    ["dest_domain", xdr.ScVal.scvU32(p.q.destDomain)],
    ["user", xdr.ScVal.scvBytes(StellarSdk.StrKey.decodeEd25519PublicKey(p.q.user))],
    ["amount", i128(p.amount)],
    ["settu_fee", i128(p.settuFee)],
    ["network_fee", i128(p.networkFee)],
    ["native_fee", i128(p.nativeFee)],
    ["mint_recipient", bytes(p.q.mintRecipient)],
    ["max_fee", i128(p.maxFee)],
    ["min_finality", xdr.ScVal.scvU32(p.q.minFinality)],
    ["deadline", xdr.ScVal.scvU64(new xdr.Uint64(BigInt(p.q.deadline)))],
    ["nonce", bytes(p.q.nonce)],
    ["hook_data", bytes(p.q.hookData)],
  ];
  fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return xdr.ScVal.scvMap(fields.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })));
}

async function buildStellar(
  p: ParsedQuote,
  userAddress: string,
  contract: string,
  d: BuildSourceTxDeps,
): Promise<SourceTx> {
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(p.q.user)) invalidQuote();
  if (userAddress !== p.q.user) {
    throw new BuildTxError("wrong_user", "This quote is for a different wallet.");
  }
  // Server bug guard: the contract would reject with BurnAmountHasDust.
  if ((p.amount - p.settuFee - p.networkFee) % TEN !== ZERO) {
    throw new Error("internal: Stellar burn amount is not a multiple of 10");
  }

  const server = d.stellarServer();
  const latest = await server.getLatestLedger();
  const approveExpiry = latest.sequence + STELLAR_APPROVE_LEDGER_OFFSET;
  const account = await server.getAccount(userAddress);

  const op = new StellarSdk.Contract(contract).call(
    "bridge",
    new StellarSdk.Address(userAddress).toScVal(),
    quoteArgsScVal(p),
    bytes(p.raw.signature),
    xdr.ScVal.scvU32(approveExpiry),
  );
  return { family: "stellar", xdr: await buildAndAssemble(server, account, op) };
}

/**
 * Same tail as stellar-cctp.ts buildAndAssemble: simulate, bump fee, assemble.
 * Also used by owner-txs.ts for the admin's owner-signed limit changes.
 */
export async function buildAndAssemble(
  server: StellarRpcLike,
  sourceAccount: StellarSdk.Account,
  operation: xdr.Operation,
  failMessage: string = "This transfer can't be prepared. Check your USDC and XLM balances, then get a new quote.",
): Promise<string> {
  const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: CCTP_CONFIG.stellarNetworkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(STELLAR_TX_TIMEOUT_SEC)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    console.error("[bridge/build-tx] Stellar simulation failed:", sim.error);
    throw new BuildTxError("simulation_failed", failMessage);
  }
  const ok = sim as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse;

  if (ok.result?.auth) {
    const desiredExpiration = ok.latestLedger + AUTH_EXPIRATION_LEDGER_BUMP;
    for (const entry of ok.result.auth) {
      const creds = entry.credentials();
      if (creds.switch().name === "sorobanCredentialsAddress") {
        creds.address().signatureExpirationLedger(desiredExpiration);
      }
    }
  }

  const originalFee = parseInt(tx.fee, 10);
  const simMinFee = parseInt(ok.minResourceFee ?? "0", 10);
  const targetFee = Math.ceil((originalFee + simMinFee) * 1.5);
  const preAssemblyFee = Math.max(targetFee - simMinFee, originalFee);
  (tx as unknown as { _fee: string })._fee = preAssemblyFee.toString();

  return StellarSdk.rpc.assembleTransaction(tx, ok).build().toXDR();
}

// ---------------------------------------------------------------- EIP-2612 permit

export type UsdcReadFn = "name" | "version" | "nonces";

export interface PermitDeps {
  bridgeContractFor(chain: BridgeChainKey): string;
  readUsdc(chain: BridgeChainKey, usdc: Address, fn: UsdcReadFn, args: unknown[]): Promise<unknown>;
}

const PERMIT_READ_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

function isRevert(e: unknown): boolean {
  if (e instanceof ContractFunctionRevertedError) return true;
  return e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError) !== null;
}

/**
 * EIP-2612 typed data for a USDC permit owner → the chain's bridge contract.
 * name/nonce are read on-chain. `version()` falls back to "2" (Circle's
 * FiatTokenV2+ value) ONLY when the call reverts (a token without version());
 * an RPC/network failure throws instead, since a wrong domain version makes
 * the permit silently fail and the bridge then revert on transferFrom.
 */
export async function permitTypedData(
  chain: BridgeChainKey,
  owner: string,
  amount: bigint,
  deadline: bigint,
  deps: Partial<PermitDeps> = {},
) {
  const d: PermitDeps = { ...defaultPermitDeps(), ...deps };
  const c = BRIDGE_CHAINS[chain];
  if (c.family !== "evm" || !c.chainId) throw new Error(`${chain} has no EIP-2612 USDC`);
  if (!isAddress(owner, { strict: false })) throw new Error("owner must be an EVM address");
  const usdc = getAddress(c.usdc);
  const ownerAddr = getAddress(owner);
  const spender = getAddress(d.bridgeContractFor(chain));

  const [name, version, nonce] = await Promise.all([
    d.readUsdc(chain, usdc, "name", []),
    d.readUsdc(chain, usdc, "version", []).catch((e) => {
      if (isRevert(e)) return "2";
      throw e;
    }),
    d.readUsdc(chain, usdc, "nonces", [ownerAddr]),
  ]);
  if (typeof name !== "string" || typeof version !== "string" || typeof nonce !== "bigint") {
    throw new Error("unexpected USDC permit read result");
  }

  return {
    domain: { name, version, chainId: c.chainId, verifyingContract: usdc },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit" as const,
    message: { owner: ownerAddr, spender, value: amount, nonce, deadline },
  };
}

// ---------------------------------------------------------------- defaults

const RPC_TIMEOUT_MS = 8_000;

function evmClient(chain: BridgeChainKey) {
  const envVar = BRIDGE_CHAINS[chain].rpcEnvVar;
  const rpc = process.env[envVar];
  if (!rpc) throw new Error(`${envVar} is not set`);
  return createPublicClient({ transport: http(rpc, { timeout: RPC_TIMEOUT_MS }) });
}

export function defaultBuildSourceTxDeps(): BuildSourceTxDeps {
  return {
    now: () => Math.floor(Date.now() / 1000),
    bridgeContractFor: envBridgeContractFor,
    evmAllowance: (chain, owner, spender) =>
      evmClient(chain).readContract({
        address: getAddress(BRIDGE_CHAINS[chain].usdc),
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, spender],
      }),
    stellarServer: () => new StellarSdk.rpc.Server(CCTP_CONFIG.stellarRpcUrl),
  };
}

function defaultPermitDeps(): PermitDeps {
  return {
    bridgeContractFor: envBridgeContractFor,
    readUsdc: (chain, usdc, fn, args) =>
      evmClient(chain).readContract({
        address: usdc,
        abi: PERMIT_READ_ABI,
        functionName: fn,
        args: args as never,
      }),
  };
}
