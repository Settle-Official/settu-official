import test from "node:test";
import assert from "node:assert/strict";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { MintTxFailedError, readReceivedAtomic, type ReceivedAmountDeps } from "./received-amount";
import { BRIDGE_CHAINS } from "./chains";
import { CCTP_CONFIG } from "../cctp/constants";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddr = (a: string) => `0x${a.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
const RECIPIENT = "0x" + "2".repeat(40);
const FEE_RECIPIENT = "0x" + "3".repeat(40);
const u256 = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

function unused(): never {
  throw new Error("unexpected chain read");
}

function deps(over: Partial<ReceivedAmountDeps>): ReceivedAmountDeps {
  return { evmReceipt: unused, solanaTx: unused, stellarTx: unused, ...over };
}

test("EVM: sums USDC mint Transfers (from 0x0) to the mint recipient, ignoring the fee mint", async () => {
  const usdc = BRIDGE_CHAINS.arbitrum.usdc;
  const got = await readReceivedAtomic(
    "arbitrum",
    "0xtx",
    { mintRecipient: topicAddr(RECIPIENT) },
    deps({
      evmReceipt: async (chain, hash) => {
        assert.equal(chain, "arbitrum");
        assert.equal(hash, "0xtx");
        return {
          status: "success",
          logs: [
            { address: usdc.toLowerCase(), topics: [TRANSFER, topicAddr("0"), topicAddr(FEE_RECIPIENT)], data: u256(BigInt(50)) },
            { address: usdc, topics: [TRANSFER, topicAddr("0"), topicAddr(RECIPIENT)], data: u256(BigInt(996_950)) },
            // a non-USDC token to the same recipient is ignored
            { address: "0x" + "4".repeat(40), topics: [TRANSFER, topicAddr("0"), topicAddr(RECIPIENT)], data: u256(BigInt(7)) },
          ],
        };
      },
    }),
  );
  assert.equal(got, BigInt(996_950));
});

test("EVM: a reverted mint tx is a MintTxFailedError; a tx with no mint to the recipient throws", async () => {
  await assert.rejects(
    readReceivedAtomic("base", "0xtx", { mintRecipient: topicAddr(RECIPIENT) }, deps({
      evmReceipt: async () => ({ status: "reverted", logs: [] }),
    })),
    MintTxFailedError,
  );
  await assert.rejects(
    readReceivedAtomic("base", "0xtx", { mintRecipient: topicAddr(RECIPIENT) }, deps({
      evmReceipt: async () => ({ status: "success", logs: [] }),
    })),
    /no USDC mint/,
  );
});

test("Solana: post − pre USDC balance of the ATA named by the 32-byte mint recipient", async () => {
  const { PublicKey, Keypair } = await import("@solana/web3.js");
  const ata = Keypair.generate().publicKey;
  const mint = BRIDGE_CHAINS.solana.usdc;
  const got = await readReceivedAtomic(
    "solana",
    "sig",
    { mintRecipient: `0x${Buffer.from(ata.toBytes()).toString("hex")}` },
    deps({
      solanaTx: async (sig) => {
        assert.equal(sig, "sig");
        return {
          err: null,
          accountKeys: ["payer", ata.toBase58(), new PublicKey(mint).toBase58()],
          preTokenBalances: [],
          postTokenBalances: [{ accountIndex: 1, mint, amount: "4999500" }],
        };
      },
    }),
  );
  assert.equal(got, BigInt(4_999_500));
  await assert.rejects(
    readReceivedAtomic("solana", "sig", { mintRecipient: `0x${Buffer.from(ata.toBytes()).toString("hex")}` }, deps({
      solanaTx: async () => ({ err: { InstructionError: [0, "x"] }, accountKeys: [], preTokenBalances: [], postTokenBalances: [] }),
    })),
    MintTxFailedError,
  );
});

function transferEvent(contract: string, from: string, to: string, amount: xdr.ScVal) {
  return {
    contractId: contract,
    topics: [
      xdr.ScVal.scvSymbol("transfer"),
      new Address(from).toScVal(),
      new Address(to).toScVal(),
      nativeToScVal("USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"),
    ],
    data: amount,
  };
}

test("Stellar: the amount the Forwarder sent on to the user, scaled 7 dp → 6 dp", async () => {
  const user = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
  const tmm = CCTP_CONFIG.stellarTokenMessengerMinter;
  const got = await readReceivedAtomic("stellar", "abc", { mintRecipient: "0x" }, deps({
    stellarTx: async (hash) => {
      assert.equal(hash, "abc");
      return {
        status: "SUCCESS",
        events: [
          // mint into the forwarder (not counted)
          transferEvent(CCTP_CONFIG.stellarUsdc, tmm, CCTP_CONFIG.stellarCctpForwarder, nativeToScVal(BigInt(49_995_000), { type: "i128" })),
          // forward to the user: i128 data
          transferEvent(CCTP_CONFIG.stellarUsdc, CCTP_CONFIG.stellarCctpForwarder, user, nativeToScVal(BigInt(49_995_000), { type: "i128" })),
        ],
      };
    },
  }));
  assert.equal(got, BigInt(4_999_500));
});

test("Stellar: map-shaped transfer data ({amount, to_muxed_id}) is read too; FAILED is MintTxFailedError", async () => {
  const user = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
  const data = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: nativeToScVal(BigInt(20), { type: "i128" }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("to_muxed_id"), val: nativeToScVal(BigInt(1), { type: "u64" }) }),
  ]);
  const got = await readReceivedAtomic("stellar", "abc", { mintRecipient: "0x" }, deps({
    stellarTx: async () => ({
      status: "SUCCESS",
      events: [transferEvent(CCTP_CONFIG.stellarUsdc, CCTP_CONFIG.stellarCctpForwarder, user, data)],
    }),
  }));
  assert.equal(got, BigInt(2));
  await assert.rejects(
    readReceivedAtomic("stellar", "abc", { mintRecipient: "0x" }, deps({
      stellarTx: async () => ({ status: "FAILED", events: [] }),
    })),
    MintTxFailedError,
  );
});
