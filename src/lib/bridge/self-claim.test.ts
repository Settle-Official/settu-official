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
