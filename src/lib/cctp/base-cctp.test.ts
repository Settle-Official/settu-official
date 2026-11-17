import test from "node:test";
import assert from "node:assert/strict";
import {
  bumpFees,
  cctpMessageNonce,
  isNonceTooLowError,
  isUnderpricedError,
  usdcFloatToBaseInt,
} from "./base-cctp";

test("usdcFloatToBaseInt converts using 6 decimals", () => {
  assert.equal(usdcFloatToBaseInt("1"), BigInt(1_000_000));
  assert.equal(usdcFloatToBaseInt("0.5"), BigInt(500_000));
  assert.equal(usdcFloatToBaseInt("12.345678"), BigInt(12_345_678));
});

test("isUnderpricedError matches the replacement rejection, not other failures", () => {
  assert.equal(isUnderpricedError("Details: replacement transaction underpriced"), true);
  assert.equal(isUnderpricedError("transaction underpriced"), true);
  assert.equal(isUnderpricedError("execution reverted: Nonce already used"), false);
  assert.equal(isUnderpricedError("insufficient funds for gas * price + value"), false);
});

test("isNonceTooLowError matches a taken nonce", () => {
  assert.equal(isNonceTooLowError("nonce too low: next nonce 485, tx nonce 484"), true);
  assert.equal(isNonceTooLowError("replacement transaction underpriced"), false);
});

test("bumpFees doubles both fees, clearing the +10% replacement rule", () => {
  const bumped = bumpFees({ maxFeePerGas: BigInt(7_000_000), maxPriorityFeePerGas: BigInt(1_000_000) });
  assert.equal(bumped.maxFeePerGas, BigInt(14_000_000));
  assert.equal(bumped.maxPriorityFeePerGas, BigInt(2_000_000));
});

test("bumpFees never exceeds the 1 gwei cap, and priority never exceeds max", () => {
  const bumped = bumpFees({ maxFeePerGas: BigInt(800_000_000), maxPriorityFeePerGas: BigInt(700_000_000) });
  assert.equal(bumped.maxFeePerGas, BigInt(1_000_000_000));
  assert.equal(bumped.maxPriorityFeePerGas, BigInt(1_000_000_000));
});

test("cctpMessageNonce reads bytes 12-44 of a v2 message", () => {
  // Header of the real Stellar -> Base message from offramp order 81b5d314
  // (2026-11-02); Base's usedNonces returned 1 for this nonce once minted.
  const message =
    "0x000000010000001b00000006" +
    "3b3c295913e8e85a96cc81e94ab140549a68f00f70da5e4bb280a9b6c7f50de2" +
    "09a3773ffd1ff361f8315d629adf17d3e4730fd00a6900715431ed4b142aded2";
  assert.equal(
    cctpMessageNonce(message),
    "0x3b3c295913e8e85a96cc81e94ab140549a68f00f70da5e4bb280a9b6c7f50de2",
  );
  assert.throws(() => cctpMessageNonce("0x00000001"));
});

// ------------------------------------------------------------ submitEvmMint

import { decodeFunctionData, type Hex } from "viem";
import { submitEvmMint, submitBaseMint, CctpBaseGasError, type EvmClients } from "./base-cctp";
import { CCTP_CONFIG, EVM_MESSAGE_TRANSMITTER_V2 } from "./constants";
import type { GasReading } from "../notify/gas-alert";

const RECEIVE_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const MSG = ("0x000000010000000600000003" + "ab".repeat(32) + "00".repeat(40)) as Hex;

function fakeClients(o: { used?: bigint; balance?: bigint; status?: string } = {}) {
  const sent: { to: Hex; data: Hex }[] = [];
  const reads: { address: string; args: unknown[] }[] = [];
  const clients = {
    account: { address: "0x" + "9".repeat(40) },
    publicClient: {
      readContract: async (a: { address: string; args: unknown[] }) => {
        reads.push(a);
        return o.used ?? BigInt(0);
      },
      getBalance: async () => o.balance ?? BigInt(10) ** BigInt(18),
      getTransactionCount: async () => 7,
      estimateFeesPerGas: async () => ({ maxFeePerGas: BigInt(10), maxPriorityFeePerGas: BigInt(1) }),
      waitForTransactionReceipt: async () => ({ status: o.status ?? "success" }),
    },
    walletClient: {
      sendTransaction: async (tx: { to: Hex; data: Hex }) => {
        sent.push(tx);
        return "0xminted";
      },
    },
  } as unknown as EvmClients;
  return { clients, sent, reads };
}

test("submitEvmMint sends receiveMessage to the chain's MessageTransmitterV2 from the bridge relayer", async () => {
  const f = fakeClients();
  const seen: string[] = [];
  const reports: GasReading[] = [];
  const tx = await submitEvmMint(
    "polygon",
    { messageHex: MSG, attestationHex: "0x1234" },
    {
      signer: "bridge",
      deps: {
        clients: (chain, signer) => (seen.push(`${chain}:${signer}`), f.clients),
        reportGasBalance: async (r) => void reports.push(r),
      },
    },
  );
  assert.equal(tx, "0xminted");
  assert.deepEqual(seen, ["polygon:bridge"]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, EVM_MESSAGE_TRANSMITTER_V2);
  assert.equal(f.reads[0].address, EVM_MESSAGE_TRANSMITTER_V2);
  const decoded = decodeFunctionData({ abi: RECEIVE_ABI, data: f.sent[0].data });
  assert.deepEqual(decoded.args, [MSG, "0x1234"]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].unit, "POL");
  assert.match(reports[0].wallet, /Polygon/);
});

test("submitEvmMint returns null without sending when usedNonces is set", async () => {
  const f = fakeClients({ used: BigInt(1) });
  const tx = await submitEvmMint("arbitrum", { messageHex: MSG, attestationHex: "0x12" }, {
    signer: "bridge",
    deps: { clients: () => f.clients, reportGasBalance: async () => {} },
  });
  assert.equal(tx, null);
  assert.equal(f.sent.length, 0);
});

test("submitEvmMint below the gas floor reports and throws CctpBaseGasError without sending", async () => {
  const f = fakeClients({ balance: BigInt(1) });
  const reports: GasReading[] = [];
  await assert.rejects(
    submitEvmMint("ethereum", { messageHex: MSG, attestationHex: "0x12" }, {
      signer: "bridge",
      deps: { clients: () => f.clients, reportGasBalance: async (r) => void reports.push(r) },
    }),
    CctpBaseGasError,
  );
  assert.equal(f.sent.length, 0);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].unit, "ETH");
});

test("a reverted bridge mint throws (so it is retried), never reports success", async () => {
  const f = fakeClients({ status: "reverted" });
  await assert.rejects(
    submitEvmMint("optimism", { messageHex: MSG, attestationHex: "0x12" }, {
      signer: "bridge",
      deps: { clients: () => f.clients, reportGasBalance: async () => {} },
    }),
    /reverted/,
  );
});

test("submitBaseMint (offramp) stays on Base with the offramp hot wallet and Base's transmitter", async () => {
  const f = fakeClients();
  const seen: string[] = [];
  const reports: GasReading[] = [];
  const tx = await submitBaseMint(
    { messageHex: MSG, attestationHex: "0x12" },
    {
      clients: (chain, signer) => (seen.push(`${chain}:${signer}`), f.clients),
      reportGasBalance: async (r) => void reports.push(r),
    },
  );
  assert.equal(tx, "0xminted");
  assert.deepEqual(seen, ["base:offramp"]);
  assert.equal(f.sent[0].to, CCTP_CONFIG.baseMessageTransmitterV2);
  assert.equal(reports[0].wallet, "Base relayer");
});
