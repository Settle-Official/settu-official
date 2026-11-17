import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Hex } from "viem";
import { Address, nativeToScVal, xdr, StrKey } from "@stellar/stellar-sdk";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  InvalidEventError,
  TxNotIndexedError,
  readBridgedEvent,
  decodeSolanaBridged,
  decodeStellarBridged,
  solanaTxLogs,
  stellarContractEvents,
} from "./read-source-event";
import { SETTU_BRIDGE_IDL_JSON, settuBridgeCoder } from "../solana/settu-bridge";

const BRIDGE = "0x1111111111111111111111111111111111111111";
const USER = "0x2222222222222222222222222222222222222222";
const NONCE = ("0x" + "ab".repeat(32)) as Hex;
const MR = ("0x" + "00".repeat(12) + "33".repeat(20)) as Hex;
const HASH = "0x" + "cd".repeat(32);
const item = parseAbiItem(
  "event Bridged(bytes32 indexed nonce, address indexed user, uint256 amount, uint256 settuFee, uint256 networkFee, uint256 nativeFee, uint32 destDomain, bytes32 mintRecipient, uint32 minFinality)",
);

function evmLog(address: string) {
  return {
    address,
    topics: encodeEventTopics({ abi: [item], eventName: "Bridged", args: { nonce: NONCE, user: USER } }) as Hex[],
    data: encodeAbiParameters(
      [
        { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
        { type: "uint32" }, { type: "bytes32" }, { type: "uint32" },
      ],
      [BigInt(1_000_000), BigInt(5_000), BigInt(100), BigInt(7), 6, MR, 2000],
    ),
  };
}

test("EVM: reads our event, case-insensitive address match", async () => {
  process.env.BRIDGE_CONTRACT_BASE = BRIDGE;
  const ev = await readBridgedEvent("base", HASH, {
    evmLogs: async () => [evmLog(BRIDGE.toLowerCase())],
    stellarEvents: async () => null,
    solanaLogs: async () => null,
  });
  assert.ok(ev);
  assert.equal(ev.amount, BigInt(1_000_000));
  assert.equal(ev.settuFee, BigInt(5_000));
  assert.equal(ev.networkFee, BigInt(100));
  assert.equal(ev.destDomain, 6);
  assert.equal(ev.minFinality, 2000);
  assert.equal(ev.mintRecipient, MR);
  assert.equal(ev.nonce, NONCE);
  assert.equal(ev.user.toLowerCase(), USER);
});

test("EVM: event from another contract is rejected", async () => {
  process.env.BRIDGE_CONTRACT_BASE = BRIDGE;
  const ev = await readBridgedEvent("base", HASH, {
    evmLogs: async () => [evmLog("0x9999999999999999999999999999999999999999")],
    stellarEvents: async () => null,
    solanaLogs: async () => null,
  });
  assert.equal(ev, null);
});

test("EVM: missing tx / no logs -> null", async () => {
  process.env.BRIDGE_CONTRACT_BASE = BRIDGE;
  const d = { evmLogs: async () => null, stellarEvents: async () => null, solanaLogs: async () => null };
  assert.equal(await readBridgedEvent("base", HASH, d), null);
});

// ---------------------------------------------------------------- Solana

const SOL_PROGRAM = "3CGxb2E9ASpizQtoL8wykokiZ8BH19MXMWmgy17KQmD1";
const OTHER_PROGRAM = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
const SOL_USER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SIG = "5".repeat(87);
const noEvm = { evmLogs: async () => null, stellarEvents: async () => null };

/** `Program data:` payload of a Bridged event, encoded with the IDL coder. */
function bridgedData(amount = 5_000_000): string {
  const disc = (SETTU_BRIDGE_IDL_JSON.events as unknown as { name: string; discriminator: number[] }[]).find(
    (e) => e.name === "Bridged",
  )!.discriminator;
  const body = settuBridgeCoder.types.encode("Bridged", {
    nonce: [...Buffer.from(NONCE.slice(2), "hex")],
    user: new PublicKey(SOL_USER),
    amount: new BN(amount),
    settu_fee: new BN(25_000),
    network_fee: new BN(630_000),
    native_fee: new BN(7_000),
    dest_domain: 27,
    mint_recipient: [...Buffer.from(MR.slice(2), "hex")],
    min_finality: 2000,
  });
  return Buffer.concat([Buffer.from(disc), body]).toString("base64");
}

/** Logs of a bridge tx; `emitter` is the program whose frame the event is logged in. */
function solLogs(emitter = SOL_PROGRAM, data = bridgedData()): string[] {
  return [
    "Program Ed25519SigVerify111111111111111111111111111 invoke [1]",
    "Program Ed25519SigVerify111111111111111111111111111 success",
    `Program ${SOL_PROGRAM} invoke [1]`,
    "Program log: Instruction: Bridge",
    `Program ${OTHER_PROGRAM} invoke [2]`,
    ...(emitter === OTHER_PROGRAM ? [`Program data: ${data}`] : []),
    `Program ${OTHER_PROGRAM} consumed 50000 of 150000 compute units`,
    `Program ${OTHER_PROGRAM} success`,
    ...(emitter === SOL_PROGRAM ? [`Program data: ${data}`] : []),
    `Program ${SOL_PROGRAM} consumed 90000 of 200000 compute units`,
    `Program ${SOL_PROGRAM} success`,
  ];
}

test("Solana: decodes our Bridged event from the program's own log frame (6-decimal units)", async () => {
  process.env.BRIDGE_CONTRACT_SOLANA = SOL_PROGRAM;
  let asked = "";
  const ev = await readBridgedEvent("solana", SIG, {
    ...noEvm,
    solanaLogs: async (sig) => {
      asked = sig;
      return solLogs();
    },
  });
  assert.equal(asked, SIG);
  assert.ok(ev);
  assert.equal(ev.nonce, NONCE);
  assert.equal(ev.user, SOL_USER);
  assert.equal(ev.amount, BigInt(5_000_000));
  assert.equal(ev.settuFee, BigInt(25_000));
  assert.equal(ev.networkFee, BigInt(630_000));
  assert.equal(ev.nativeFee, BigInt(7_000));
  assert.equal(ev.destDomain, 27);
  assert.equal(ev.mintRecipient, MR);
  assert.equal(ev.minFinality, 2000);
});

test("Solana: a Bridged-shaped log from another program is rejected", () => {
  assert.equal(decodeSolanaBridged(solLogs(OTHER_PROGRAM), SOL_PROGRAM), null);
  // Our program never invoked at all.
  const foreign = [
    `Program ${OTHER_PROGRAM} invoke [1]`,
    `Program data: ${bridgedData()}`,
    `Program ${OTHER_PROGRAM} success`,
  ];
  assert.equal(decodeSolanaBridged(foreign, SOL_PROGRAM), null);
  // A log line can't fake an invoke frame (msg! output is "Program log: …").
  const spoof = [
    `Program ${OTHER_PROGRAM} invoke [1]`,
    `Program log: Program ${SOL_PROGRAM} invoke [2]`,
    `Program data: ${bridgedData()}`,
    `Program ${OTHER_PROGRAM} success`,
  ];
  assert.equal(decodeSolanaBridged(spoof, SOL_PROGRAM), null);
});

test("Solana: other events from our program are ignored; failed tx -> null; not found -> TxNotIndexedError", async () => {
  process.env.BRIDGE_CONTRACT_SOLANA = SOL_PROGRAM;
  const notBridged = solLogs(SOL_PROGRAM, Buffer.alloc(40, 1).toString("base64"));
  assert.equal(decodeSolanaBridged(notBridged, SOL_PROGRAM), null);
  assert.equal(await readBridgedEvent("solana", SIG, { ...noEvm, solanaLogs: async () => null }), null);
  await assert.rejects(
    readBridgedEvent("solana", SIG, {
      ...noEvm,
      solanaLogs: async () => {
        throw new TxNotIndexedError();
      },
    }),
    (e: unknown) => e instanceof TxNotIndexedError,
  );
});

test("Solana: default reader requires success and uses maxSupportedTransactionVersion 0", async () => {
  const seen: unknown[] = [];
  const conn = (tx: unknown) => ({
    getTransaction: async (sig: string, opts: unknown) => {
      seen.push([sig, opts]);
      return tx as never;
    },
  });
  await assert.rejects(solanaTxLogs(conn(null), SIG), (e: unknown) => e instanceof TxNotIndexedError);
  assert.equal(await solanaTxLogs(conn({ meta: { err: { InstructionError: [1, "x"] }, logMessages: solLogs() } }), SIG), null);
  assert.equal(await solanaTxLogs(conn({ meta: null }), SIG), null);
  assert.deepEqual(await solanaTxLogs(conn({ meta: { err: null, logMessages: ["a"] } }), SIG), ["a"]);
  assert.deepEqual(seen[0], [SIG, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
});

const CID = StrKey.encodeContract(Buffer.alloc(32, 7));
const SUSER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 9));
function stellarEvent(contractId: string, amount: bigint, topicName = "bridged") {
  const data = xdr.ScVal.scvVec([
    new Address(SUSER).toScVal(),
    nativeToScVal(amount, { type: "i128" }),
    nativeToScVal(BigInt(50_000), { type: "i128" }),
    nativeToScVal(BigInt(1_000), { type: "i128" }),
    nativeToScVal(BigInt(0), { type: "i128" }),
    nativeToScVal(6, { type: "u32" }),
    xdr.ScVal.scvBytes(Buffer.from(MR.slice(2), "hex")),
    nativeToScVal(1000, { type: "u32" }),
  ]);
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: Buffer.from(StrKey.decodeContract(contractId)) as any,
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({
      topics: [xdr.ScVal.scvSymbol(topicName), xdr.ScVal.scvBytes(Buffer.from(NONCE.slice(2), "hex"))],
      data,
    })),
  });
}

test("Stellar: decodes event, converts 7 to 6 decimals", () => {
  const ev = decodeStellarBridged([stellarEvent(CID, BigInt(10_000_000))], CID)!;
  assert.equal(ev.amount, BigInt(1_000_000));
  assert.equal(ev.settuFee, BigInt(5_000));
  assert.equal(ev.networkFee, BigInt(100));
  assert.equal(ev.user, SUSER);
  assert.equal(ev.destDomain, 6);
  assert.equal(ev.minFinality, 1000);
  assert.equal(ev.nonce, NONCE);
  assert.equal(ev.mintRecipient, MR);
});

test("Stellar: other contract or other topic ignored; non-divisible amount throws", () => {
  const other = StrKey.encodeContract(Buffer.alloc(32, 8));
  assert.equal(decodeStellarBridged([stellarEvent(other, BigInt(10_000_000))], CID), null);
  assert.equal(decodeStellarBridged([stellarEvent(CID, BigInt(10_000_000), "other")], CID), null);
  assert.throws(() => decodeStellarBridged([stellarEvent(CID, BigInt(10_000_001))], CID), (e: unknown) => e instanceof InvalidEventError);
});

test("Stellar: events extracted from a v3 meta", () => {
  const e = stellarEvent(CID, BigInt(10_000_000));
  const sm = new xdr.SorobanTransactionMeta({
    ext: new xdr.SorobanTransactionMetaExt(0),
    events: [e],
    returnValue: xdr.ScVal.scvVoid(),
    diagnosticEvents: [],
  });
  const v3 = new xdr.TransactionMetaV3({
    ext: new xdr.ExtensionPoint(0),
    txChangesBefore: [],
    operations: [],
    txChangesAfter: [],
    sorobanMeta: sm,
  });
  const b64 = new xdr.TransactionMeta(3, v3).toXDR("base64");
  const evs = stellarContractEvents(b64);
  assert.equal(evs.length, 1);
  assert.ok(decodeStellarBridged(evs, CID));
});
