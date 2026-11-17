import test from "node:test";
import assert from "node:assert/strict";
import { advanceLocked } from "./advance";
import type { CctpTransferRecord } from "./cctp-store";

test("an attested bridge record is left untouched (no mint dispatch)", async () => {
  const rec: CctpTransferRecord = {
    id: "0xabc", direction: "bridge", sourceDomain: 6, destDomain: 5,
    burnTxHash: "0xabc", mintRecipient: "0x", status: "attested",
    attestationMessage: "0x01", attestationSignature: "0x02",
    attempts: 0, createdAt: 0, updatedAt: 0,
  };
  // Without the guard this would call submitMintAndForward (network) and throw.
  assert.equal(await advanceLocked(rec.id, rec), "attested");
});
