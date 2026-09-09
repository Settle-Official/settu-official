import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  usdcFloatToSolanaAtomic,
  baseAddressToSolanaMintRecipient,
  deriveCctpPdas,
  buildDepositForBurnIx,
} from "./deposit-for-burn";

test("usdcFloatToSolanaAtomic — 6 decimals, same as EVM", () => {
  assert.equal(usdcFloatToSolanaAtomic("1.5"), BigInt(1_500_000));
  assert.equal(usdcFloatToSolanaAtomic("0.000001"), BigInt(1));
  assert.equal(usdcFloatToSolanaAtomic("100"), BigInt(100_000_000));
  assert.equal(usdcFloatToSolanaAtomic("2.1234567"), BigInt(2_123_456)); // truncates, never rounds up
});

test("baseAddressToSolanaMintRecipient — left-pads the 20-byte address to bytes32", () => {
  const pk = baseAddressToSolanaMintRecipient(
    "0x000000000000000000000000000000000000dEaD",
  );
  // 12 zero bytes + the 20-byte address, lowercased.
  assert.equal(
    Buffer.from(pk.toBytes()).toString("hex"),
    "000000000000000000000000000000000000000000000000000000000000dead",
  );
});

test("baseAddressToSolanaMintRecipient — a full non-zero address round-trips", () => {
  const pk = baseAddressToSolanaMintRecipient(
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  );
  assert.equal(
    Buffer.from(pk.toBytes()).toString("hex"),
    "000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  );
});

// Golden values captured from the Task 1 confirmed devnet burn
// (3fqraNdK…) — these PDAs are program-derived, identical on devnet/mainnet.
test("deriveCctpPdas — matches the live devnet transaction's accounts", () => {
  const pdas = deriveCctpPdas(6);
  assert.equal(pdas.messageTransmitter.toBase58(), "W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU");
  assert.equal(pdas.tokenMessenger.toBase58(), "AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W");
  assert.equal(pdas.tokenMinter.toBase58(), "E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux");
  assert.equal(pdas.remoteTokenMessenger.toBase58(), "BwmDYtQ7jFj8ddaTmKa7fz9hyuK9n58mvc8G7DYNcKjM");
});

test("deriveCctpPdas — the remote token messenger is domain-specific", () => {
  assert.notEqual(
    deriveCctpPdas(6).remoteTokenMessenger.toBase58(),
    deriveCctpPdas(0).remoteTokenMessenger.toBase58(),
  );
});

test("buildDepositForBurnIx — 18-account instruction to the TokenMessengerMinter program", async () => {
  const owner = new PublicKey("FbgrhPZ6oACLnRLKtsdDgwWFfQW8CALJLiHsEuDCyzs4");
  const eventAccount = new PublicKey("Gp9VAwJxFGRDYa6Ge2uiP88hmVVhj3at6cGsabyGH71U");
  const ix = await buildDepositForBurnIx({
    owner,
    ownerUsdcAta: new PublicKey("C5cts1TQXWUYVLtrW4v8jqQ529c7veSwWXMoJBorUyQw"),
    amountAtomic: BigInt(100_000),
    mintRecipient: baseAddressToSolanaMintRecipient(
      "0x000000000000000000000000000000000000dEaD",
    ),
    maxFeeAtomic: BigInt(0),
    eventAccount,
  });

  assert.equal(ix.programId.toBase58(), "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
  assert.equal(ix.keys.length, 18);
  // deposit_for_burn discriminator (from the vendored IDL).
  assert.equal(Buffer.from(ix.data.subarray(0, 8)).toString("hex"), "d73c3d2e723780b0");

  const signers = ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58());
  assert.ok(signers.includes(owner.toBase58()));
  assert.ok(signers.includes(eventAccount.toBase58()));
});

test("buildDepositForBurnIx — fast vs standard sets the finality threshold byte", async () => {
  const args = {
    owner: PublicKey.default,
    ownerUsdcAta: PublicKey.default,
    amountAtomic: BigInt(1_000_000),
    mintRecipient: baseAddressToSolanaMintRecipient(
      "0x000000000000000000000000000000000000dEaD",
    ),
    maxFeeAtomic: BigInt(100),
    eventAccount: PublicKey.default,
  };
  const fast = await buildDepositForBurnIx({ ...args, fast: true });
  const std = await buildDepositForBurnIx({ ...args, fast: false });
  assert.notEqual(fast.data.toString("hex"), std.data.toString("hex"));
});
