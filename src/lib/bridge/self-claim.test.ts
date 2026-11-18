import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseAbi } from "viem";

import { buildSelfClaimTx, SelfClaimError } from "./self-claim";
import { EVM_MESSAGE_TRANSMITTER_V2 } from "../cctp/constants";
import { BRIDGE_CHAINS } from "./chains";
import type { CctpTransferRecord } from "../cctp/cctp-store";

const ABI = parseAbi(["function receiveMessage(bytes message, bytes attestation) returns (bool)"]);

function rec(over: Partial<CctpTransferRecord> = {}): CctpTransferRecord {
  return {
    id: "0xhash",
    direction: "bridge",
    status: "attested",
    attestationMessage: "0x0102",
    attestationSignature: "0x0304",
    bridge: { source: "solana", dest: "base" },
    ...over,
  } as unknown as CctpTransferRecord;
}

test("an attested bridge to an EVM chain gives receiveMessage(message, attestation) on that chain's transmitter", () => {
  const tx = buildSelfClaimTx(rec());
  assert.equal(tx.family, "evm");
  assert.equal(tx.to, EVM_MESSAGE_TRANSMITTER_V2);
  assert.equal(tx.chainId, BRIDGE_CHAINS.base.chainId);
  const d = decodeFunctionData({ abi: ABI, data: tx.data });
  assert.equal(d.functionName, "receiveMessage");
  assert.deepEqual(d.args, ["0x0102", "0x0304"]);
});

test("a bridge without its attestation yet can't be claimed", () => {
  assert.throws(() => buildSelfClaimTx(rec({ attestationSignature: undefined })), SelfClaimError);
});

test("a completed bridge can't be claimed again", () => {
  assert.throws(() => buildSelfClaimTx(rec({ status: "completed" })), SelfClaimError);
});

test("Stellar and Solana destinations aren't self-claimable from the app yet (Ruling AJ)", () => {
  assert.throws(
    () => buildSelfClaimTx(rec({ bridge: { source: "base", dest: "stellar" } } as Partial<CctpTransferRecord>)),
    (e: unknown) => e instanceof SelfClaimError && e.code === "unsupported_dest",
  );
});

// ------------------------------------------------ final review: confirming a claim

import { confirmSelfClaim, type ConfirmClaimDeps } from "./self-claim";

function claimDeps(r: CctpTransferRecord, over: Partial<ConfirmClaimDeps> = {}) {
  let current = r;
  const recorded: CctpTransferRecord[] = [];
  const d: ConfirmClaimDeps = {
    get: async () => current,
    isMinted: async () => true,
    readReceivedAtomic: async () => BigInt(4_950_000),
    update: async (_id, patch) => {
      current = { ...current, ...patch, bridge: { ...current.bridge!, ...(patch.bridge ?? {}) } } as CctpTransferRecord;
    },
    recordCompleted: async (x) => {
      recorded.push(x);
    },
    ...over,
  };
  return { d, recorded, current: () => current };
}

const FAILED = () =>
  rec({ status: "failed", mintRecipient: "0x00000000000000000000000000000000000000000000000000000000000000aa" } as Partial<CctpTransferRecord>);

test("a confirmed claim of a failed bridge completes it with what arrived, and records it", async () => {
  const h = claimDeps(FAILED());
  const r = await confirmSelfClaim("0xhash", "0xclaim", h.d);
  assert.equal(r.status, "completed");
  assert.equal(h.current().mintTxHash, "0xclaim");
  assert.equal(h.current().bridge?.receivedAtomic, "4950000");
  assert.equal(h.recorded.length, 1);
});

test("a claim tx is not trusted unless this bridge's own message is minted on-chain", async () => {
  const h = claimDeps(FAILED(), { isMinted: async () => false });
  await assert.rejects(confirmSelfClaim("0xhash", "0xclaim", h.d), (e: unknown) =>
    e instanceof SelfClaimError && e.code === "not_minted");
  assert.equal(h.current().status, "failed");
});

test("a claim tx that didn't mint to this bridge's recipient is refused", async () => {
  const h = claimDeps(FAILED(), {
    readReceivedAtomic: async () => {
      throw new Error("no USDC mint to the recipient in the destination tx");
    },
  });
  await assert.rejects(confirmSelfClaim("0xhash", "0xclaim", h.d));
  assert.equal(h.current().status, "failed");
});

test("confirming an already-completed bridge changes nothing", async () => {
  const h = claimDeps(rec({ status: "completed", mintTxHash: "0xrelayer" }));
  const r = await confirmSelfClaim("0xhash", "0xclaim", h.d);
  assert.equal(r.mintTxHash, "0xrelayer");
  assert.equal(h.recorded.length, 0);
});
