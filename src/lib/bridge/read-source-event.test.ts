import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Hex } from "viem";
import { Address, nativeToScVal, xdr, StrKey } from "@stellar/stellar-sdk";
import { InvalidEventError, readBridgedEvent, decodeStellarBridged, stellarContractEvents } from "./read-source-event";

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
  });
  assert.equal(ev, null);
});

test("EVM: missing tx / no logs -> null", async () => {
  process.env.BRIDGE_CONTRACT_BASE = BRIDGE;
  const d = { evmLogs: async () => null, stellarEvents: async () => null };
  assert.equal(await readBridgedEvent("base", HASH, d), null);
});

test("Solana source: clear not-supported error", async () => {
  await assert.rejects(
    readBridgedEvent("solana", "x", { evmLogs: async () => null, stellarEvents: async () => null }),
    /solana source not supported yet/,
  );
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
