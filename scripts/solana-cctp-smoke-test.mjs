/*
 * Throwaway diagnostic for the Solana offramp-source plan (Task 1).
 *
 * Against Solana DEVNET, builds and sends a real CCTP V2 `deposit_for_burn`
 * (Solana domain 5 -> Base Sepolia domain 6), signed by the wallet AND an
 * ephemeral MessageSent event keypair (the two-signer model), then polls
 * Circle's sandbox Iris for the attestation. Proves the instruction layout /
 * account list / arg encoding are correct before any app code is built on it.
 *
 * Does NOT touch mainnet or real funds. Does NOT exercise a browser wallet —
 * the Phantom partial-sign check is Task 1 Step 3, done separately.
 *
 * Setup:
 *   1. A devnet keypair JSON. Default ~/.config/solana/id.json, or set
 *      SOLANA_SMOKE_KEYPAIR=/path/to/keypair.json
 *   2. Fund it: `solana airdrop 2 <addr> --url devnet` (SOL) and get devnet
 *      USDC from https://faucet.circle.com (select "Solana Devnet").
 *   3. node scripts/solana-cctp-smoke-test.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";

const { AnchorProvider, Program, Wallet, BN } = anchor;

const RPC = process.env.SOLANA_RPC_URL_DEVNET || "https://api.devnet.solana.com";
const DEVNET_USDC = new PublicKey(
  process.env.SOLANA_USDC_ADDRESS || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);
const DEST_DOMAIN = 6; // Base (Sepolia on the testnet side)
const DEST_EVM_ADDR = process.env.DEST_EVM_ADDR || "0x000000000000000000000000000000000000dEaD";
const AMOUNT_USDC = process.env.SMOKE_AMOUNT || "0.1";
const IRIS = "https://iris-api-sandbox.circle.com";

const MT_ID = new PublicKey("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
const TMM_ID = new PublicKey("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");

const TMM_IDL = JSON.parse(
  readFileSync(
    join(process.cwd(), "src/lib/solana/idl/token_messenger_minter_v2.json"),
    "utf8",
  ),
);

function keypairFromBytes(bytes) {
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(
    `key is ${bytes.length} bytes — expected 32 (seed) or 64 (secret key)`,
  );
}

function loadKeypair() {
  const path =
    process.env.SOLANA_SMOKE_KEYPAIR || join(homedir(), ".config/solana/id.json");
  const raw = readFileSync(path, "utf8").trim();
  const bs58 = anchor.utils.bytes.bs58;

  const coerce = (v) => {
    if (Array.isArray(v)) return keypairFromBytes(Uint8Array.from(v));
    if (typeof v === "string") return keypairFromBytes(bs58.decode(v.trim()));
    throw new Error("unrecognised key value type");
  };

  // 1. solana-keygen JSON: array of 32 or 64 numbers.
  // 2. JSON-quoted base58 string.
  // 3. Wallet export object: { privateKey | secretKey | secret_key | seed: ... }.
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) || typeof parsed === "string") return coerce(parsed);
    if (parsed && typeof parsed === "object") {
      for (const k of ["privateKey", "secretKey", "secret_key", "seed", "key", "id"]) {
        if (parsed[k] != null) return coerce(parsed[k]);
      }
      throw new Error(
        `keypair JSON object has no recognised key field (keys: ${Object.keys(parsed).join(", ")})`,
      );
    }
  } catch (err) {
    if (err.message?.includes("recognised") || err.message?.includes("bytes"))
      throw err;
    // not JSON — try bare base58
  }
  return keypairFromBytes(bs58.decode(raw));
}

function pda(label, programId, extra = []) {
  const seeds = [Buffer.from(label)];
  for (const s of extra) {
    if (typeof s === "string") seeds.push(Buffer.from(s));
    else if (s instanceof PublicKey) seeds.push(s.toBuffer());
    else seeds.push(Buffer.from(s));
  }
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function evmAddrToBytes32Pubkey(addr) {
  const hex = addr.replace(/^0x/, "").padStart(64, "0");
  return new PublicKey(Buffer.from(hex, "hex"));
}

function usdcAtomic(amount) {
  const [i, f = ""] = amount.split(".");
  return new BN(BigInt(i || "0") * 1_000_000n + BigInt((f + "000000").slice(0, 6)));
}

async function pollAttestation(sig) {
  // Query-param form, matching src/lib/cctp/iris-client.ts (the path form
  // `/v2/messages/5/<sig>` 404s).
  const url = `${IRIS}/v2/messages/5?transactionHash=${sig}`;
  for (let i = 0; i < 60; i++) {
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const m = data?.messages?.[0];
      if (m && m.status === "complete") return m;
      process.stdout.write(`  attestation ${m?.status ?? "pending"}...\r`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

async function main() {
  const kp = loadKeypair();
  console.log("Wallet:", kp.publicKey.toBase58());

  const connection = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(kp), {
    commitment: "confirmed",
  });
  const tmm = new Program(TMM_IDL, provider);

  const solBal = await connection.getBalance(kp.publicKey);
  console.log("SOL balance:", (solBal / 1e9).toFixed(4));
  if (solBal < 5_000_000) {
    console.error("Need at least ~0.005 devnet SOL. Airdrop: solana airdrop 2 --url devnet");
    process.exit(1);
  }

  const ata = getAssociatedTokenAddressSync(DEVNET_USDC, kp.publicKey);
  try {
    const acc = await getAccount(connection, ata);
    console.log("Devnet USDC balance:", (Number(acc.amount) / 1e6).toFixed(6));
    if (Number(acc.amount) < Number(AMOUNT_USDC) * 1e6) {
      console.error("Not enough devnet USDC. Get some at https://faucet.circle.com");
      process.exit(1);
    }
  } catch {
    console.error("No devnet USDC token account. Get devnet USDC at https://faucet.circle.com");
    process.exit(1);
  }

  const eventKp = Keypair.generate();
  console.log("Ephemeral MessageSent event account:", eventKp.publicKey.toBase58());

  const accounts = {
    owner: kp.publicKey,
    eventRentPayer: kp.publicKey,
    burnTokenAccount: ata,
    messageTransmitter: pda("message_transmitter", MT_ID),
    tokenMessenger: pda("token_messenger", TMM_ID),
    remoteTokenMessenger: pda("remote_token_messenger", TMM_ID, [String(DEST_DOMAIN)]),
    tokenMinter: pda("token_minter", TMM_ID),
    burnTokenMint: DEVNET_USDC,
    messageSentEventData: eventKp.publicKey,
  };
  console.log("\nDerived accounts:");
  for (const [k, v] of Object.entries(accounts)) console.log(`  ${k}: ${v.toBase58()}`);

  console.log("\nBuilding deposit_for_burn instruction...");
  const ix = await tmm.methods
    .depositForBurn({
      amount: usdcAtomic(AMOUNT_USDC),
      destinationDomain: DEST_DOMAIN,
      mintRecipient: evmAddrToBytes32Pubkey(DEST_EVM_ADDR),
      destinationCaller: PublicKey.default,
      maxFee: new BN(0), // standard transfer, fee 0
      minFinalityThreshold: 2000, // standard
    })
    .accounts(accounts)
    .instruction();

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }))
    .add(ix);

  console.log("Sending (signers: wallet + event keypair)...");
  const sig = await sendAndConfirmTransaction(connection, tx, [kp, eventKp], {
    commitment: "confirmed",
  });
  console.log("\n✅ BURN TX CONFIRMED:", sig);
  console.log(`   https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  console.log("\nPolling Circle sandbox for attestation (up to 2 min)...");
  const msg = await pollAttestation(sig);
  if (msg) {
    console.log("\n✅ ATTESTATION COMPLETE — source domain 5, message ready to mint on Base.");
    console.log("   eventNonce:", msg.eventNonce);
    console.log("\nSMOKE TEST PASSED — instruction layout + two-signer flow + attestation all work.");
    process.exit(0);
  } else {
    console.error(
      "\n⚠️  Burn landed but attestation did not complete in time. Re-check with:",
    );
    console.error(`   curl "${IRIS}/v2/messages/5/${sig}"`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n❌ FAILED:", err);
  process.exit(1);
});
