/**
 * Client side of Settu's Solana bridge program (contracts/solana/settu_bridge).
 *
 * The instruction discriminator, account order/flags and the borsh layouts of
 * `QuoteArgs` and the `Bridged` event all come from the vendored Anchor IDL
 * (`./idl/settu_bridge.json`, copied from the program's
 * target/idl/settu_bridge.json). Re-vendor it whenever the program changes.
 *
 * Circle CCTP V2 PDAs follow the `Bridge` accounts struct in
 * programs/settu_bridge/src/lib.rs (the same seeds its LiteSVM test uses);
 * the four shared with the offramp burn come from `deriveCctpPdas`.
 */

import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import SETTU_BRIDGE_IDL from "./idl/settu_bridge.json" with { type: "json" };
import { SOLANA_CONFIG } from "./config";
import { deriveCctpPdas } from "./deposit-for-burn";
import { deriveUsdcAta, SPL_TOKEN_PROGRAM_ID } from "../bridge/address-live";
import { BRIDGE_CHAINS } from "../bridge/chains";

export const SETTU_BRIDGE_IDL_JSON = SETTU_BRIDGE_IDL as unknown as Idl;
export const settuBridgeCoder = new BorshCoder(SETTU_BRIDGE_IDL_JSON);

const MT_ID = new PublicKey(SOLANA_CONFIG.messageTransmitterV2);
const TMM_ID = new PublicKey(SOLANA_CONFIG.tokenMessengerMinterV2);

/** Seeds from programs/settu_bridge/src/lib.rs. */
export const CONFIG_SEED = "config";
export const NONCE_SEED = "nonce";

/** The CCTP domains a Solana-source bridge can burn to (every other chain). */
const DEST_DOMAINS = Object.values(BRIDGE_CHAINS)
  .filter((c) => c.family !== "solana")
  .map((c) => c.cctpDomain);

function pda(seeds: (Buffer | Uint8Array)[], program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), program)[0];
}

const hexBytes = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");

/** The `bridge` instruction argument (`QuoteArgs`); amounts 6-decimal USDC, nativeFee lamports. */
export interface SolanaQuoteArgs {
  sourceDomain: number;
  destDomain: number;
  user: string;
  amount: bigint;
  settuFee: bigint;
  networkFee: bigint;
  nativeFee: bigint;
  mintRecipient: string;
  maxFee: bigint;
  minFinality: number;
  deadline: number;
  nonce: string;
  hookData: string;
}

export function encodeBridgeIxData(q: SolanaQuoteArgs): Buffer {
  return settuBridgeCoder.instruction.encode("bridge", {
    quote: {
      source_domain: q.sourceDomain,
      dest_domain: q.destDomain,
      user: new PublicKey(q.user),
      amount: new BN(q.amount.toString()),
      settu_fee: new BN(q.settuFee.toString()),
      network_fee: new BN(q.networkFee.toString()),
      native_fee: new BN(q.nativeFee.toString()),
      mint_recipient: [...hexBytes(q.mintRecipient)],
      max_fee: new BN(q.maxFee.toString()),
      min_finality: q.minFinality,
      deadline: new BN(q.deadline.toString()),
      nonce: [...hexBytes(q.nonce)],
      hook_data: hexBytes(q.hookData),
    },
  });
}

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  address?: string;
}

function bridgeIdlAccounts(): IdlAccount[] {
  const ix = (SETTU_BRIDGE_IDL_JSON.instructions as unknown as { name: string; accounts: IdlAccount[] }[]).find(
    (i) => i.name === "bridge",
  );
  if (!ix) throw new Error("internal: settu_bridge IDL has no bridge instruction");
  return ix.accounts;
}

/** Every account of `bridge`, by IDL name. */
export function bridgeAccounts(p: {
  programId: string;
  user: string;
  feeWallet: string;
  nonce: string;
  destDomain: number;
  eventAccount: string;
}): Record<string, PublicKey> {
  const program = new PublicKey(p.programId);
  const user = new PublicKey(p.user);
  const mint = new PublicKey(SOLANA_CONFIG.usdcMint);
  const cctp = deriveCctpPdas(p.destDomain);
  return {
    user,
    config: pda([Buffer.from(CONFIG_SEED)], program),
    nonce_record: pda([Buffer.from(NONCE_SEED), hexBytes(p.nonce)], program),
    burn_token_account: new PublicKey(deriveUsdcAta(p.user, SOLANA_CONFIG.usdcMint)),
    fee_wallet: new PublicKey(p.feeWallet),
    fee_token_account: new PublicKey(deriveUsdcAta(p.feeWallet, SOLANA_CONFIG.usdcMint)),
    usdc_mint: mint,
    instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    sender_authority_pda: pda([Buffer.from("sender_authority")], TMM_ID),
    denylist_account: pda([Buffer.from("denylist_account"), user.toBuffer()], TMM_ID),
    message_transmitter: cctp.messageTransmitter,
    token_messenger: cctp.tokenMessenger,
    remote_token_messenger: cctp.remoteTokenMessenger,
    token_minter: cctp.tokenMinter,
    local_token: pda([Buffer.from("local_token"), mint.toBuffer()], TMM_ID),
    message_sent_event_data: new PublicKey(p.eventAccount),
    message_transmitter_program: MT_ID,
    token_messenger_minter_program: TMM_ID,
    token_program: new PublicKey(SPL_TOKEN_PROGRAM_ID),
    system_program: SystemProgram.programId,
    event_authority: pda([Buffer.from("__event_authority")], TMM_ID),
  };
}

/** The `bridge` instruction: accounts in IDL order with the IDL's flags. */
export function buildBridgeIx(p: {
  programId: string;
  quote: SolanaQuoteArgs;
  feeWallet: string;
  eventAccount: string;
}): TransactionInstruction {
  const accounts = bridgeAccounts({
    programId: p.programId,
    user: p.quote.user,
    feeWallet: p.feeWallet,
    nonce: p.quote.nonce,
    destDomain: p.quote.destDomain,
    eventAccount: p.eventAccount,
  });
  const keys = bridgeIdlAccounts().map((a) => {
    const pubkey = accounts[a.name];
    if (!pubkey) throw new Error(`internal: no value for bridge account ${a.name}`);
    if (a.address && a.address !== pubkey.toBase58()) {
      throw new Error(`internal: bridge account ${a.name} is not the IDL's ${a.address}`);
    }
    return { pubkey, isWritable: a.writable === true, isSigner: a.signer === true };
  });
  return new TransactionInstruction({
    programId: new PublicKey(p.programId),
    keys,
    data: encodeBridgeIxData(p.quote),
  });
}

/**
 * What BRIDGE_SOLANA_ALT must contain: every `bridge` account that is the
 * same for all users (one remote_token_messenger per destination domain).
 * The per-user/per-quote accounts (user, nonce record, user ATA, denylist
 * PDA, event account) and the invoked programs stay in the static keys.
 */
export function settuBridgeLookupTableAddresses(programId: string, feeWallet: string): string[] {
  const a = bridgeAccounts({
    programId,
    user: PublicKey.default.toBase58(),
    feeWallet,
    nonce: `0x${"00".repeat(32)}`,
    destDomain: DEST_DOMAINS[0],
    eventAccount: PublicKey.default.toBase58(),
  });
  const shared = [
    a.config,
    a.fee_wallet,
    a.fee_token_account,
    a.usdc_mint,
    a.instructions,
    a.sender_authority_pda,
    a.message_transmitter,
    a.token_messenger,
    ...DEST_DOMAINS.map((d) => deriveCctpPdas(d).remoteTokenMessenger),
    a.token_minter,
    a.local_token,
    a.message_transmitter_program,
    a.token_messenger_minter_program,
    a.token_program,
    a.system_program,
    a.event_authority,
  ];
  return shared.map((k) => k.toBase58());
}
