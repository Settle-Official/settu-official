/**
 * Builds the CCTP V2 `deposit_for_burn` instruction for burning USDC on
 * Solana (source domain 5) to be minted on Base (domain 6). The instruction
 * itself is unsigned and RPC-free — the `solana-build-tx` route assembles it
 * into a transaction with a fresh blockhash; the user's wallet + the
 * ephemeral MessageSent event keypair sign it (see the Solana offramp plan).
 *
 * Account layout / arg encoding are driven by the vendored on-chain IDL
 * (`./idl/token_messenger_minter_v2.json`) via Anchor, and were verified by a
 * real confirmed devnet burn (plan Task 1). No forwarder hook — the
 * destination is Paycrest's Base receive address directly.
 */
// Named imports — @coral-xyz/anchor is CJS and its default export is
// undefined under Next's webpack bundling (`import anchor from …` only works
// in a plain Node ESM script).
import {
  Program,
  AnchorProvider,
  BN,
  type Idl,
  type Wallet,
} from "@coral-xyz/anchor";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { SOLANA_CONFIG, usdcFloatToSolanaAtomic } from "./config";
import { CCTP_DOMAIN, FINALITY_THRESHOLD } from "../cctp/constants";
import TMM_IDL from "./idl/token_messenger_minter_v2.json" with { type: "json" };

// Re-export so existing importers (and the tests) keep working.
export { usdcFloatToSolanaAtomic };

const MT_ID = new PublicKey(SOLANA_CONFIG.messageTransmitterV2);
const TMM_ID = new PublicKey(SOLANA_CONFIG.tokenMessengerMinterV2);

/**
 * CCTP's `mintRecipient` on the destination side is a 32-byte value. For a
 * 20-byte EVM address that means left-padding with 12 zero bytes, then
 * treating those 32 bytes as a Solana `PublicKey`.
 */
export function baseAddressToSolanaMintRecipient(
  address: `0x${string}` | string,
): PublicKey {
  const hex = address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  if (hex.length !== 64) throw new Error(`bad Base address: ${address}`);
  return new PublicKey(Buffer.from(hex, "hex"));
}

function pda(
  label: string,
  programId: PublicKey,
  extraSeeds: (string | PublicKey)[] = [],
): PublicKey {
  const seeds: Buffer[] = [Buffer.from(label)];
  for (const s of extraSeeds) {
    seeds.push(typeof s === "string" ? Buffer.from(s) : s.toBuffer());
  }
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

/**
 * The four PDAs the caller must pass to `deposit_for_burn` (Anchor
 * auto-resolves the rest from IDL seeds). Deterministic, no RPC. Seeds taken
 * from Circle's `examples/utils.ts` `getDepositForBurnPdas` and confirmed
 * against the Task 1 devnet transaction.
 */
export function deriveCctpPdas(destinationDomain: number) {
  return {
    messageTransmitter: pda("message_transmitter", MT_ID),
    tokenMessenger: pda("token_messenger", TMM_ID),
    tokenMinter: pda("token_minter", TMM_ID),
    remoteTokenMessenger: pda("remote_token_messenger", TMM_ID, [
      String(destinationDomain),
    ]),
  };
}

// Anchor's `Program` needs a provider, but `.instruction()` never touches it
// for `deposit_for_burn` (every account is passed or PDA-derivable from IDL
// seeds). A stub connection + no-op wallet keeps this module RPC-free.
let cachedProgram: Program | null = null;
function getProgram(): Program {
  if (!cachedProgram) {
    const stubWallet = {
      publicKey: PublicKey.default,
      signTransaction: async <T>(t: T) => t,
      signAllTransactions: async <T>(t: T[]) => t,
    };
    const provider = new AnchorProvider(
      new Connection("http://127.0.0.1:1"),
      stubWallet as Wallet,
      { commitment: "confirmed" },
    );
    cachedProgram = new Program(TMM_IDL as Idl, provider);
  }
  return cachedProgram;
}

export async function buildDepositForBurnIx(params: {
  owner: PublicKey;
  ownerUsdcAta: PublicKey;
  amountAtomic: bigint;
  mintRecipient: PublicKey;
  maxFeeAtomic: bigint;
  eventAccount: PublicKey;
  /** Fast Transfer (default) vs Standard. */
  fast?: boolean;
}): Promise<TransactionInstruction> {
  const pdas = deriveCctpPdas(CCTP_DOMAIN.base);
  return getProgram()
    .methods.depositForBurn({
      amount: new BN(params.amountAtomic.toString()),
      destinationDomain: CCTP_DOMAIN.base,
      mintRecipient: params.mintRecipient,
      destinationCaller: PublicKey.default, // permissionless mint
      maxFee: new BN(params.maxFeeAtomic.toString()),
      minFinalityThreshold:
        params.fast === false
          ? FINALITY_THRESHOLD.standard
          : FINALITY_THRESHOLD.fast,
    })
    .accounts({
      owner: params.owner,
      eventRentPayer: params.owner,
      burnTokenAccount: params.ownerUsdcAta,
      messageTransmitter: pdas.messageTransmitter,
      tokenMessenger: pdas.tokenMessenger,
      remoteTokenMessenger: pdas.remoteTokenMessenger,
      tokenMinter: pdas.tokenMinter,
      burnTokenMint: new PublicKey(SOLANA_CONFIG.usdcMint),
      messageSentEventData: params.eventAccount,
    })
    .instruction() as unknown as Promise<TransactionInstruction>;
}
