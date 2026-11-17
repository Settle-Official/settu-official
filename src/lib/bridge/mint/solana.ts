/**
 * Solana destination mint for the user bridge: `receive_message` on
 * MessageTransmitterV2, which CPIs into TokenMessengerMinterV2's
 * `handle_receive_*_message` to mint USDC into the recipient's ATA.
 * Settu's relayer pays and signs (payer = caller; destination_caller is 0).
 *
 * Accounts:
 * - The 9 named accounts and the instruction discriminator come from the
 *   vendored MessageTransmitterV2 IDL (../../solana/idl/, vendored in commit
 *   e4924c9 from circlefin/solana-cctp-contracts); `receiveMessageIx` checks
 *   the IDL still lists them in this order.
 * - The 11 remaining accounts (TokenMessengerMinterV2's side) and every PDA
 *   seed follow Circle's own example, read raw at circlefin/
 *   solana-cctp-contracts@ec16e95d28ee47f7832df4203ae07b5981d146fc:
 *   examples/v2/utilsV2.ts (getReceiveMessagePdasV2) and examples/v2/solana.ts
 *   (receiveMessageSol). The UsedNonce PDA is ["used_nonce", nonce(32)].
 *
 * Size: with Circle's 2-signature attestation, receive_message alone is
 * ~1226 bytes of the 1232-byte packet limit, so the recipient's ATA creation
 * only fits in the same transaction through an address lookup table
 * (BRIDGE_SOLANA_LOOKUP_TABLE, holding `solanaLookupTableAddresses`). Without
 * one, the (idempotent) ATA creation is sent as its own transaction first.
 *
 * Env: BRIDGE_SOLANA_RELAYER_KEYPAIR (path to a JSON keypair file),
 * SOLANA_RPC_URL, optional BRIDGE_SOLANA_LOOKUP_TABLE,
 * BRIDGE_SOLANA_MIN_GAS_SOL (default 0.01), BRIDGE_SOLANA_WARN_GAS_SOL (0.1).
 */

import { readFileSync } from "node:fs";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { StrKey } from "@stellar/stellar-sdk";
import MT_IDL from "../../solana/idl/message_transmitter_v2.json" with { type: "json" };
import { SOLANA_CONFIG, requireSolanaRpcUrl } from "../../solana/config";
import { parseCctpMessage } from "../../cctp/message";
import { reportGasBalance, type GasReading } from "../../notify/gas-alert";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  deriveUsdcAta,
} from "../address-live";
import { BRIDGE_CHAINS } from "../chains";

const MT_ID = new PublicKey(SOLANA_CONFIG.messageTransmitterV2);
const TMM_ID = new PublicKey(SOLANA_CONFIG.tokenMessengerMinterV2);
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
const TOKEN_PROGRAM = new PublicKey(SPL_TOKEN_PROGRAM_ID);
const ATA_PROGRAM = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
const PACKET_DATA_SIZE = 1232;
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Anchor account discriminators, from the vendored IDLs. */
const TOKEN_MESSENGER_DISCRIMINATOR = Buffer.from([162, 4, 242, 52, 147, 243, 221, 96]);
/** TokenMessenger: 8 disc + denylister, owner, pending_owner (3×32) + u32 + u8 → fee_recipient. */
const FEE_RECIPIENT_OFFSET = 8 + 32 * 3 + 4 + 1;

export class SolanaGasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaGasError";
  }
}

function pda(program: PublicKey, ...seeds: (Buffer | string)[]): PublicKey {
  return PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)),
    program,
  )[0];
}

export function usedNoncePda(nonce: Buffer): PublicKey {
  return pda(MT_ID, "used_nonce", nonce);
}

function usdcMint(): PublicKey {
  return new PublicKey(SOLANA_CONFIG.usdcMint);
}

interface IdlIx {
  name: string;
  discriminator: number[];
  accounts: { name: string }[];
}

const RECEIVE_MESSAGE_ACCOUNTS = [
  "payer",
  "caller",
  "authority_pda",
  "message_transmitter",
  "used_nonce",
  "receiver",
  "system_program",
  "event_authority",
  "program",
] as const;

function receiveMessageIdl(): IdlIx {
  const ix = (MT_IDL as { instructions: IdlIx[] }).instructions.find(
    (i) => i.name === "receive_message",
  );
  const names = ix?.accounts.map((a) => a.name) ?? [];
  if (!ix || names.join(",") !== RECEIVE_MESSAGE_ACCOUNTS.join(",")) {
    throw new Error("MessageTransmitterV2 IDL receive_message accounts changed; re-check before minting");
  }
  return ix;
}

function borshBytes(hex: string): Buffer {
  const bytes = Buffer.from(hex.replace(/^0x/i, ""), "hex");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
}

/** The `receive_message` instruction, accounts per the IDL + Circle's example. */
export function receiveMessageIx(p: {
  payer: PublicKey;
  messageHex: string;
  attestationHex: string;
  recipientAta: PublicKey;
  /** TokenMessenger.fee_recipient (a wallet); its USDC ATA takes the fee. */
  feeRecipient: PublicKey;
}): TransactionInstruction {
  const idl = receiveMessageIdl();
  const m = parseCctpMessage(p.messageHex);
  const remoteDomain = String(m.sourceDomain);
  const mint = usdcMint();
  const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({
    pubkey,
    isSigner,
    isWritable,
  });
  const named: Record<(typeof RECEIVE_MESSAGE_ACCOUNTS)[number], ReturnType<typeof meta>> = {
    payer: meta(p.payer, true, true),
    caller: meta(p.payer, true, false),
    authority_pda: meta(pda(MT_ID, "message_transmitter_authority", TMM_ID.toBuffer()), false, false),
    message_transmitter: meta(pda(MT_ID, "message_transmitter"), false, false),
    used_nonce: meta(usedNoncePda(m.nonce), false, true),
    receiver: meta(TMM_ID, false, false),
    system_program: meta(SYSTEM_PROGRAM, false, false),
    event_authority: meta(pda(MT_ID, "__event_authority"), false, false),
    program: meta(MT_ID, false, false),
  };
  const remaining = [
    meta(pda(TMM_ID, "token_messenger"), false, false),
    meta(pda(TMM_ID, "remote_token_messenger", remoteDomain), false, false),
    meta(pda(TMM_ID, "token_minter"), false, true),
    meta(pda(TMM_ID, "local_token", mint.toBuffer()), false, true),
    meta(pda(TMM_ID, "token_pair", remoteDomain, m.burnToken), false, false),
    meta(new PublicKey(deriveUsdcAta(p.feeRecipient.toBase58(), mint.toBase58())), false, true),
    meta(p.recipientAta, false, true),
    meta(pda(TMM_ID, "custody", mint.toBuffer()), false, true),
    meta(TOKEN_PROGRAM, false, false),
    meta(pda(TMM_ID, "__event_authority"), false, false),
    meta(TMM_ID, false, false),
  ];
  return new TransactionInstruction({
    programId: MT_ID,
    keys: [...RECEIVE_MESSAGE_ACCOUNTS.map((n) => named[n]), ...remaining],
    data: Buffer.concat([
      Buffer.from(idl.discriminator),
      borshBytes(p.messageHex),
      borshBytes(p.attestationHex),
    ]),
  });
}

/** Associated Token Account program `CreateIdempotent` (instruction 1). */
export function createAtaIdempotentIx(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** The 32-byte CCTP `burnToken` of each non-Solana chain's USDC. */
function remoteUsdcBytes(key: keyof typeof BRIDGE_CHAINS): Buffer {
  const c = BRIDGE_CHAINS[key];
  if (c.family === "stellar") return Buffer.from(StrKey.decodeContract(c.usdc));
  return Buffer.from(c.usdc.replace(/^0x/i, "").toLowerCase().padStart(64, "0"), "hex");
}

/**
 * Every account a bridge `receive_message` (+ ATA creation) touches that is
 * the same for every transfer — what an operator puts in the lookup table
 * named by BRIDGE_SOLANA_LOOKUP_TABLE. `feeRecipients` are TokenMessenger
 * fee_recipient wallets (their USDC ATAs are listed).
 */
export function solanaLookupTableAddresses(feeRecipients: PublicKey[]): PublicKey[] {
  const mint = usdcMint();
  const out = [
    pda(MT_ID, "message_transmitter_authority", TMM_ID.toBuffer()),
    pda(MT_ID, "message_transmitter"),
    pda(MT_ID, "__event_authority"),
    TMM_ID,
    SYSTEM_PROGRAM,
    pda(TMM_ID, "token_messenger"),
    pda(TMM_ID, "token_minter"),
    pda(TMM_ID, "local_token", mint.toBuffer()),
    pda(TMM_ID, "custody", mint.toBuffer()),
    TOKEN_PROGRAM,
    pda(TMM_ID, "__event_authority"),
    mint,
    ...feeRecipients.map((f) => new PublicKey(deriveUsdcAta(f.toBase58(), mint.toBase58()))),
  ];
  for (const key of Object.keys(BRIDGE_CHAINS) as (keyof typeof BRIDGE_CHAINS)[]) {
    const c = BRIDGE_CHAINS[key];
    if (c.family === "solana") continue;
    const domain = String(c.cctpDomain);
    out.push(pda(TMM_ID, "remote_token_messenger", domain));
    out.push(pda(TMM_ID, "token_pair", domain, remoteUsdcBytes(key)));
  }
  return out;
}

export interface SolanaMintDeps {
  relayer(): Keypair;
  getAccountInfo(pubkey: PublicKey): Promise<{ data: Buffer } | null>;
  /** Lamports. */
  getBalance(pubkey: PublicKey): Promise<number>;
  getLookupTable(): Promise<AddressLookupTableAccount | null>;
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  /** Sends and waits for confirmation; throws if the tx failed. Returns the signature. */
  sendAndConfirm(
    tx: VersionedTransaction,
    blockhash: { blockhash: string; lastValidBlockHeight: number },
  ): Promise<string>;
  reportGasBalance(r: GasReading): Promise<void>;
}

export interface SolanaMintParams {
  messageHex: string;
  attestationHex: string;
  /** The USDC token account the message mints to (base58). */
  recipientAta: string;
  /** Create the ATA (idempotently) before minting; needs `recipientOwner`. */
  createAta: boolean;
  /** Wallet that owns `recipientAta`; required when `createAta`. */
  recipientOwner?: string;
}

function loadRelayerKeypair(): Keypair {
  const path = process.env.BRIDGE_SOLANA_RELAYER_KEYPAIR;
  if (!path) throw new Error("BRIDGE_SOLANA_RELAYER_KEYPAIR not configured");
  let secret: number[];
  try {
    secret = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Never echo the file contents.
    throw new Error("BRIDGE_SOLANA_RELAYER_KEYPAIR is not a readable JSON keypair file");
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

let cachedConnection: Connection | null = null;
function connection(): Connection {
  cachedConnection ??= new Connection(requireSolanaRpcUrl(), "confirmed");
  return cachedConnection;
}

export function defaultSolanaMintDeps(): SolanaMintDeps {
  return {
    relayer: loadRelayerKeypair,
    getAccountInfo: async (pk) => {
      const info = await connection().getAccountInfo(pk, "confirmed");
      return info ? { data: Buffer.from(info.data) } : null;
    },
    getBalance: (pk) => connection().getBalance(pk, "confirmed"),
    getLookupTable: async () => {
      const addr = process.env.BRIDGE_SOLANA_LOOKUP_TABLE?.trim();
      if (!addr) return null;
      const res = await connection().getAddressLookupTable(new PublicKey(addr));
      if (!res.value) throw new Error("BRIDGE_SOLANA_LOOKUP_TABLE not found on-chain");
      return res.value;
    },
    getLatestBlockhash: () => connection().getLatestBlockhash("confirmed"),
    sendAndConfirm: async (tx, bh) => {
      const sig = await connection().sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      const res = await connection().confirmTransaction({ signature: sig, ...bh }, "confirmed");
      if (res.value.err) {
        throw new Error(`Solana mint tx ${sig} failed: ${JSON.stringify(res.value.err)}`);
      }
      return sig;
    },
    reportGasBalance,
  };
}

async function assertSolanaGasFloor(deps: SolanaMintDeps, relayer: PublicKey): Promise<void> {
  const floor = parseFloat(process.env.BRIDGE_SOLANA_MIN_GAS_SOL || "0.01");
  const warn = parseFloat(process.env.BRIDGE_SOLANA_WARN_GAS_SOL || "0.1");
  const balance = (await deps.getBalance(relayer)) / LAMPORTS_PER_SOL;
  await deps.reportGasBalance({
    wallet: "Bridge Solana relayer",
    address: relayer.toBase58(),
    unit: "SOL",
    balance,
    floor,
    warn,
  });
  if (balance < floor) {
    throw new SolanaGasError(
      `Bridge Solana relayer SOL balance ${balance} below floor ${floor}; refusing to submit`,
    );
  }
}

async function readFeeRecipient(deps: SolanaMintDeps): Promise<PublicKey> {
  const info = await deps.getAccountInfo(pda(TMM_ID, "token_messenger"));
  if (
    !info ||
    info.data.length < FEE_RECIPIENT_OFFSET + 32 ||
    !info.data.subarray(0, 8).equals(TOKEN_MESSENGER_DISCRIMINATOR)
  ) {
    throw new Error("TokenMessengerV2 account missing or malformed");
  }
  return new PublicKey(info.data.subarray(FEE_RECIPIENT_OFFSET, FEE_RECIPIENT_OFFSET + 32));
}

/** A signed v0 transaction, or null when it would exceed the packet limit. */
function buildTx(
  payer: Keypair,
  ixs: TransactionInstruction[],
  blockhash: string,
  lut: AddressLookupTableAccount | null,
): VersionedTransaction | null {
  try {
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message(lut ? [lut] : []);
    const tx = new VersionedTransaction(message);
    tx.sign([payer]);
    return tx.serialize().length <= PACKET_DATA_SIZE ? tx : null;
  } catch (e) {
    // web3.js throws a RangeError when the message overruns its buffer.
    if (e instanceof RangeError) return null;
    throw e;
  }
}

/**
 * Mints a bridge's USDC on Solana. Returns the signature of the
 * receive_message transaction, or null when the message was already received
 * (its UsedNonce PDA exists). Throws SolanaGasError below the gas floor.
 */
export async function submitSolanaMint(
  params: SolanaMintParams,
  deps: SolanaMintDeps = defaultSolanaMintDeps(),
): Promise<string | null> {
  const m = parseCctpMessage(params.messageHex);
  const ata = new PublicKey(params.recipientAta);
  if (!m.mintRecipient.equals(ata.toBuffer())) {
    throw new Error("message mint recipient does not match the recipient ATA");
  }
  let owner: PublicKey | null = null;
  if (params.createAta) {
    if (
      !params.recipientOwner ||
      deriveUsdcAta(params.recipientOwner, usdcMint().toBase58()) !== ata.toBase58()
    ) {
      throw new Error("recipient ATA is not the owner's USDC ATA; refusing to create it");
    }
    owner = new PublicKey(params.recipientOwner);
  }

  const used = await deps.getAccountInfo(usedNoncePda(m.nonce));
  if (used && (used.data.length < 9 || used.data[8] !== 0)) return null;

  const relayer = deps.relayer();
  await assertSolanaGasFloor(deps, relayer.publicKey);

  const feeRecipient = await readFeeRecipient(deps);
  const receiveIx = receiveMessageIx({
    payer: relayer.publicKey,
    messageHex: params.messageHex,
    attestationHex: params.attestationHex,
    recipientAta: ata,
    feeRecipient,
  });
  const lut = await deps.getLookupTable();

  const send = async (ixs: TransactionInstruction[]): Promise<string | null> => {
    const bh = await deps.getLatestBlockhash();
    const tx = buildTx(relayer, ixs, bh.blockhash, lut);
    return tx ? deps.sendAndConfirm(tx, bh) : null;
  };

  if (owner) {
    const ataIx = createAtaIdempotentIx(relayer.publicKey, ata, owner, usdcMint());
    const bh = await deps.getLatestBlockhash();
    const both = buildTx(relayer, [ataIx, receiveIx], bh.blockhash, lut);
    if (both) return deps.sendAndConfirm(both, bh);
    // Too big for one packet without a lookup table: the idempotent ATA
    // creation goes first on its own (harmless if it already exists).
    if ((await send([ataIx])) === null) throw new Error("ATA creation tx exceeds the packet size");
  }
  const sig = await send([receiveIx]);
  if (sig === null) throw new Error("receive_message tx exceeds the packet size");
  return sig;
}
