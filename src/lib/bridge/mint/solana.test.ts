import test from "node:test";
import assert from "node:assert/strict";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  TransactionMessage,
  type VersionedTransaction,
} from "@solana/web3.js";
import {
  SolanaGasError,
  receiveMessageIx,
  solanaLookupTableAddresses,
  submitSolanaMint,
  usedNoncePda,
  type SolanaMintDeps,
} from "./solana";
import { buildV2Message } from "../../cctp/message.test-helper";
import { SOLANA_CONFIG } from "../../solana/config";
import { deriveUsdcAta } from "../address-live";
import MT_IDL from "../../solana/idl/message_transmitter_v2.json" with { type: "json" };
import type { GasReading } from "../../notify/gas-alert";

const MT = new PublicKey(SOLANA_CONFIG.messageTransmitterV2);
const TMM = new PublicKey(SOLANA_CONFIG.tokenMessengerMinterV2);
const USDC = new PublicKey(SOLANA_CONFIG.usdcMint);
const pda = (program: PublicKey, ...seeds: (Buffer | string)[]) =>
  PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)),
    program,
  )[0];

const relayer = Keypair.generate();
const owner = Keypair.generate().publicKey;
const ata = new PublicKey(deriveUsdcAta(owner.toBase58(), USDC.toBase58()));
const feeRecipient = Keypair.generate().publicKey;
const NONCE = "5a".repeat(32);
const BASE_USDC = "036cbd53842c5426634e7929541ec2318f3dcf7e";

const MESSAGE = buildV2Message({
  sourceDomain: 6,
  destDomain: 5,
  nonce: NONCE,
  finalityThresholdExecuted: 1000,
  burnToken: BASE_USDC,
  mintRecipient: Buffer.from(ata.toBytes()).toString("hex"),
  amount: BigInt(5_000_000),
});
const ATTESTATION = "0x" + "77".repeat(130); // two 65-byte signatures

/** TokenMessenger account bytes: discriminator, 3 pubkeys, u32, u8, fee_recipient, … */
function tokenMessengerData(fee: PublicKey): Buffer {
  return Buffer.concat([
    Buffer.from([162, 4, 242, 52, 147, 243, 221, 96]),
    Buffer.alloc(96),
    Buffer.alloc(4),
    Buffer.alloc(1),
    fee.toBuffer(),
    Buffer.alloc(32),
    Buffer.alloc(4),
  ]);
}

function deps(over: Partial<SolanaMintDeps> & { lut?: AddressLookupTableAccount | null; usedNonce?: boolean } = {}) {
  const sent: VersionedTransaction[] = [];
  const reports: GasReading[] = [];
  const tokenMessenger = pda(TMM, "token_messenger");
  const d: SolanaMintDeps = {
    relayer: () => relayer,
    getAccountInfo: async (pk) => {
      if (pk.equals(tokenMessenger)) return { data: tokenMessengerData(feeRecipient) };
      if (pk.equals(usedNoncePda(Buffer.from(NONCE, "hex"))) && over.usedNonce) {
        return { data: Buffer.from([212, 222, 157, 252, 130, 71, 179, 238, 1]) };
      }
      return null;
    },
    getBalance: async () => 1_000_000_000,
    getLookupTable: async () => over.lut ?? null,
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    sendAndConfirm: async (tx) => {
      sent.push(tx);
      return `sig${sent.length}`;
    },
    reportGasBalance: async (r) => void reports.push(r),
    ...over,
  };
  return { d, sent, reports };
}

function decompile(tx: VersionedTransaction, lut?: AddressLookupTableAccount) {
  return TransactionMessage.decompile(tx.message, {
    addressLookupTableAccounts: lut ? [lut] : [],
  }).instructions;
}

const params = {
  messageHex: MESSAGE,
  attestationHex: ATTESTATION,
  recipientAta: ata.toBase58(),
  createAta: false,
};

test("usedNoncePda is ['used_nonce', nonce] under MessageTransmitterV2 (Circle utilsV2.ts)", () => {
  const nonce = Buffer.from(NONCE, "hex");
  assert.ok(usedNoncePda(nonce).equals(pda(MT, "used_nonce", nonce)));
});

test("returns null without sending when the UsedNonce PDA exists (already received)", async () => {
  const { d, sent } = deps({ usedNonce: true });
  assert.equal(await submitSolanaMint(params, d), null);
  assert.equal(sent.length, 0);
});

test("receive_message: IDL discriminator, IDL account order, Circle's remaining-account order", () => {
  const ix = receiveMessageIx({
    payer: relayer.publicKey,
    messageHex: MESSAGE,
    attestationHex: ATTESTATION,
    recipientAta: ata,
    feeRecipient,
  });
  assert.ok(ix.programId.equals(MT));
  const idlIx = (MT_IDL as { instructions: { name: string; discriminator: number[]; accounts: unknown[] }[] })
    .instructions.find((i) => i.name === "receive_message")!;
  assert.deepEqual([...ix.data.subarray(0, 8)], idlIx.discriminator);
  // borsh: u32 len + message bytes, u32 len + attestation bytes
  const msgLen = ix.data.readUInt32LE(8);
  assert.equal(msgLen, (MESSAGE.length - 2) / 2);
  assert.equal(ix.data.readUInt32LE(12 + msgLen), 130);
  assert.equal(ix.data.length, 8 + 4 + msgLen + 4 + 130);

  const nonce = Buffer.from(NONCE, "hex");
  const remoteToken = new PublicKey(Buffer.from(BASE_USDC.padStart(64, "0"), "hex"));
  const expected: [PublicKey, boolean, boolean][] = [
    // IDL accounts: payer, caller, authority_pda, message_transmitter, used_nonce, receiver, system_program, event_authority, program
    [relayer.publicKey, true, true],
    [relayer.publicKey, true, false],
    [pda(MT, "message_transmitter_authority", TMM.toBuffer()), false, false],
    [pda(MT, "message_transmitter"), false, false],
    [pda(MT, "used_nonce", nonce), false, true],
    [TMM, false, false],
    [new PublicKey("11111111111111111111111111111111"), false, false],
    [pda(MT, "__event_authority"), false, false],
    [MT, false, false],
    // remaining (examples/v2/solana.ts receiveMessageSol)
    [pda(TMM, "token_messenger"), false, false],
    [pda(TMM, "remote_token_messenger", "6"), false, false],
    [pda(TMM, "token_minter"), false, true],
    [pda(TMM, "local_token", USDC.toBuffer()), false, true],
    [pda(TMM, "token_pair", "6", remoteToken.toBuffer()), false, false],
    [new PublicKey(deriveUsdcAta(feeRecipient.toBase58(), USDC.toBase58())), false, true],
    [ata, false, true],
    [pda(TMM, "custody", USDC.toBuffer()), false, true],
    [new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), false, false],
    [pda(TMM, "__event_authority"), false, false],
    [TMM, false, false],
  ];
  assert.equal(idlIx.accounts.length, 9);
  assert.equal(ix.keys.length, expected.length);
  expected.forEach(([pk, signer, writable], i) => {
    assert.ok(ix.keys[i].pubkey.equals(pk), `account ${i}`);
    assert.equal(ix.keys[i].isSigner, signer, `signer ${i}`);
    assert.equal(ix.keys[i].isWritable, writable, `writable ${i}`);
  });
});

test("rejects a message whose mint recipient is not the given ATA", async () => {
  const { d, sent } = deps();
  const other = Keypair.generate().publicKey.toBase58();
  await assert.rejects(submitSolanaMint({ ...params, recipientAta: other }, d), /mint recipient/);
  assert.equal(sent.length, 0);
});

test("no ATA needed: one receive_message tx signed by the relayer", async () => {
  const { d, sent } = deps();
  assert.equal(await submitSolanaMint(params, d), "sig1");
  assert.equal(sent.length, 1);
  const ixs = decompile(sent[0]);
  assert.equal(ixs.length, 1);
  assert.ok(ixs[0].programId.equals(MT));
  assert.ok(sent[0].serialize().length <= 1232);
});

test("createAta with a lookup table: ATA creation and receive_message share one tx", async () => {
  const lut = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: solanaLookupTableAddresses([feeRecipient]),
    },
  });
  const { d, sent } = deps({ lut });
  const sig = await submitSolanaMint({ ...params, createAta: true, recipientOwner: owner.toBase58() }, d);
  assert.equal(sig, "sig1");
  assert.equal(sent.length, 1);
  const ixs = decompile(sent[0], lut);
  const ataIx = ixs.find((i) => i.programId.toBase58() === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")!;
  assert.ok(ataIx, "has ATA create");
  assert.deepEqual([...ataIx.data], [1]); // CreateIdempotent
  assert.ok(ataIx.keys[0].pubkey.equals(relayer.publicKey));
  assert.ok(ataIx.keys[1].pubkey.equals(ata));
  assert.ok(ataIx.keys[2].pubkey.equals(owner));
  assert.ok(ataIx.keys[3].pubkey.equals(USDC));
  assert.ok(ixs.indexOf(ataIx) < ixs.findIndex((i) => i.programId.equals(MT)));
  assert.ok(sent[0].serialize().length <= 1232);
});

test("createAta without a lookup table: the tx would exceed 1232 bytes, so the ATA goes first in its own tx", async () => {
  const { d, sent } = deps();
  const sig = await submitSolanaMint({ ...params, createAta: true, recipientOwner: owner.toBase58() }, d);
  assert.equal(sent.length, 2);
  assert.equal(sig, "sig2");
  const first = decompile(sent[0]);
  assert.equal(first.length, 1);
  assert.equal(first[0].programId.toBase58(), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  assert.ok(decompile(sent[1])[0].programId.equals(MT));
  for (const tx of sent) assert.ok(tx.serialize().length <= 1232);
});

test("createAta refuses when the ATA isn't the owner's USDC ATA", async () => {
  const { d } = deps();
  await assert.rejects(
    submitSolanaMint({ ...params, createAta: true, recipientOwner: Keypair.generate().publicKey.toBase58() }, d),
    /ATA/,
  );
});

test("gas floor: below the SOL floor reports the balance and throws SolanaGasError, sending nothing", async () => {
  const { d, sent, reports } = deps({ getBalance: async () => 1_000 });
  await assert.rejects(submitSolanaMint(params, d), SolanaGasError);
  assert.equal(sent.length, 0);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].unit, "SOL");
  assert.equal(reports[0].address, relayer.publicKey.toBase58());
  assert.ok(reports[0].balance < reports[0].floor);
});
