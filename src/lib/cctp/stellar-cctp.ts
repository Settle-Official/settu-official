import * as StellarSdk from "@stellar/stellar-sdk";
import { xdr } from "@stellar/stellar-sdk";
import {
  CCTP_CONFIG,
  CCTP_DOMAIN,
  FINALITY_THRESHOLD,
  STELLAR_USDC_DECIMALS,
} from "./constants";
import { evmAddressToScvBytes32, zeroBytes32Scval } from "./address-encoding";
import {
  getCctpStellarAccount,
  assertStellarGasFloor,
  type StellarMintSigner,
} from "./stellar-hot-wallet";

const SEND_TX_TIMEOUT_SEC = 180;
const AUTH_EXPIRATION_LEDGER_BUMP = 500;

export function usdcFloatToStellarInt(amount: string): bigint {
  const [intPart, fracPart = ""] = amount.split(".");
  const frac = fracPart.padEnd(STELLAR_USDC_DECIMALS, "0").slice(0, STELLAR_USDC_DECIMALS);
  return (
    BigInt(intPart || "0") * BigInt(10) ** BigInt(STELLAR_USDC_DECIMALS) +
    BigInt(frac || "0")
  );
}

/**
 * Simulate, bump fee, and assemble a single-operation Soroban transaction —
 * identical tail logic to soroban-tx-builder.ts's buildSwapAndBridgeTx (kept
 * as a local copy rather than a cross-import so this module has zero
 * dependency on the Allbridge-era file, consistent with the "no Allbridge
 * dependency for bridging" cutover goal).
 */
async function buildAndAssemble(
  server: StellarSdk.rpc.Server,
  sourceAccount: StellarSdk.Account,
  operation: xdr.Operation,
): Promise<string> {
  const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: CCTP_CONFIG.stellarNetworkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(SEND_TX_TIMEOUT_SEC)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${(simResult as any).error}`);
  }
  const simSuccess = simResult as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse;

  if (simSuccess.result?.auth) {
    const desiredExpiration = simSuccess.latestLedger + AUTH_EXPIRATION_LEDGER_BUMP;
    for (const authEntry of simSuccess.result.auth) {
      const creds = authEntry.credentials();
      if (creds.switch().name === "sorobanCredentialsAddress") {
        creds.address().signatureExpirationLedger(desiredExpiration);
      }
    }
  }

  const originalFee = parseInt(tx.fee, 10);
  const simMinFee = parseInt((simSuccess as any).minResourceFee ?? "0", 10);
  const targetFee = Math.ceil((originalFee + simMinFee) * 1.5);
  const preAssemblyFee = Math.max(targetFee - simMinFee, originalFee);
  (tx as any)._fee = preAssemblyFee.toString();

  const finalTx = StellarSdk.rpc.assembleTransaction(tx, simSuccess).build();
  return finalTx.toXDR();
}

/** Current allowance the user's account has granted TokenMessengerMinter, in Stellar subunits. */
export async function checkStellarUsdcAllowance(owner: string): Promise<bigint> {
  const server = new StellarSdk.rpc.Server(CCTP_CONFIG.stellarRpcUrl);
  const contract = new StellarSdk.Contract(CCTP_CONFIG.stellarUsdc);
  const account = await server.getAccount(owner);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: CCTP_CONFIG.stellarNetworkPassphrase,
  })
    .addOperation(
      contract.call(
        "allowance",
        new StellarSdk.Address(owner).toScVal(),
        new StellarSdk.Address(CCTP_CONFIG.stellarTokenMessengerMinter).toScVal(),
      ),
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`allowance simulation failed: ${(sim as any).error}`);
  }
  const result = (sim as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse).result;
  if (!result?.retval) return BigInt(0);
  return StellarSdk.scValToNative(result.retval) as bigint;
}

/** Unsigned approve tx (only needed the first time, or after allowance is exhausted). */
export async function buildApproveUsdcTx(params: {
  owner: string;
  amount: bigint; // approve at least this much, in Stellar subunits
}): Promise<string> {
  const server = new StellarSdk.rpc.Server(CCTP_CONFIG.stellarRpcUrl);
  const account = await server.getAccount(params.owner);
  const latestLedger = await server.getLatestLedger();
  const expirationLedger = latestLedger.sequence + 100_000;

  const contract = new StellarSdk.Contract(CCTP_CONFIG.stellarUsdc);
  const operation = contract.call(
    "approve",
    new StellarSdk.Address(params.owner).toScVal(),
    new StellarSdk.Address(CCTP_CONFIG.stellarTokenMessengerMinter).toScVal(),
    StellarSdk.nativeToScVal(params.amount, { type: "i128" }),
    StellarSdk.nativeToScVal(expirationLedger, { type: "u32" }),
  );
  return buildAndAssemble(server, account, operation);
}

/**
 * Unsigned `deposit_for_burn` tx — offramp, Stellar source, Base destination.
 * No hook needed: Base recipients are plain EOAs, not subject to Stellar's
 * "mintRecipient must be a contract" rule (that only applies when Stellar is
 * the *destination*, handled separately for onramp in base-cctp.ts).
 */
export async function buildStellarBurnTx(params: {
  owner: string;
  amountFloat: string;
  destinationEvmAddress: string; // Paycrest's settlement address on Base
  maxFeeStellarInt: bigint;
  fast?: boolean; // default true (Fast Transfer)
}): Promise<string> {
  const server = new StellarSdk.rpc.Server(CCTP_CONFIG.stellarRpcUrl);
  const account = await server.getAccount(params.owner);

  const contract = new StellarSdk.Contract(CCTP_CONFIG.stellarTokenMessengerMinter);
  const operation = contract.call(
    "deposit_for_burn",
    new StellarSdk.Address(params.owner).toScVal(),
    StellarSdk.nativeToScVal(usdcFloatToStellarInt(params.amountFloat), { type: "i128" }),
    StellarSdk.nativeToScVal(CCTP_DOMAIN.base, { type: "u32" }),
    evmAddressToScvBytes32(params.destinationEvmAddress),
    new StellarSdk.Address(CCTP_CONFIG.stellarUsdc).toScVal(),
    zeroBytes32Scval(), // destination_caller — anyone may call receiveMessage
    StellarSdk.nativeToScVal(params.maxFeeStellarInt, { type: "i128" }),
    StellarSdk.nativeToScVal(
      params.fast === false ? FINALITY_THRESHOLD.standard : FINALITY_THRESHOLD.fast,
      { type: "u32" },
    ),
  );
  return buildAndAssemble(server, account, operation);
}

/**
 * Server-signed: submits `mint_and_forward` on the Stellar CctpForwarder for
 * an onramp transfer. Atomic per Circle's docs — mints to the forwarder and
 * pays the real recipient in one Soroban invocation, so there's no
 * partial-mint-but-unforwarded state to handle.
 *
 * `signer` picks the paying account: the onramp's hot wallet by default, or
 * the user bridge's relayer (Stellar-destination bridges). Same Forwarder,
 * same testnet-aware RPC (CCTP_CONFIG.stellarRpcUrl) either way.
 */
export async function submitMintAndForward(
  params: {
    messageHex: string; // 0x-prefixed
    attestationHex: string; // 0x-prefixed
  },
  opts: { signer?: StellarMintSigner } = {},
): Promise<string> {
  const signer = opts.signer ?? "onramp";
  await assertStellarGasFloor(signer);
  const keypair = getCctpStellarAccount(signer);
  const server = new StellarSdk.rpc.Server(CCTP_CONFIG.stellarRpcUrl);
  const account = await server.getAccount(keypair.publicKey());

  const contract = new StellarSdk.Contract(CCTP_CONFIG.stellarCctpForwarder);
  const operation = contract.call(
    "mint_and_forward",
    xdr.ScVal.scvBytes(Buffer.from(params.messageHex.replace(/^0x/i, ""), "hex")),
    xdr.ScVal.scvBytes(Buffer.from(params.attestationHex.replace(/^0x/i, ""), "hex")),
  );

  const unsignedXdr = await buildAndAssemble(server, account, operation);
  const tx = StellarSdk.TransactionBuilder.fromXDR(
    unsignedXdr,
    CCTP_CONFIG.stellarNetworkPassphrase,
  ) as StellarSdk.Transaction;
  tx.sign(keypair);

  const sendResult = await server.sendTransaction(tx);
  if (sendResult.status === "ERROR") {
    throw new Error(`mint_and_forward send failed: ${JSON.stringify(sendResult)}`);
  }
  return sendResult.hash;
}
