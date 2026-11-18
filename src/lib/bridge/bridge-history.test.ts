import test from "node:test";
import assert from "node:assert/strict";

import { bridgeHistoryRow } from "./bridge-history";
import type { CompletedBridge } from "./bridge-ledger";

const E: CompletedBridge = {
  id: "0xabc",
  source: "base",
  dest: "stellar",
  user: "0xa894a3B6fBf182D2D24Fff808B81De849cF7B41c",
  recipient: "GD6YGF422FQSOH2RJMV5WUUFGGGCFKK4TKK6SO3EQES477NBCG2VBDSI",
  speed: "fast",
  sendAtomic: "5000000",
  settuFeeAtomic: "30000",
  receivedAtomic: "4952462",
  sourceTx: "0xabc",
  destTx: "stellarhash",
  createdAt: 1_000,
  completedAt: 2_000,
};

test("a completed bridge becomes a completed USDC history row with its route and what arrived", () => {
  assert.deepEqual(bridgeHistoryRow(E), {
    id: "0xabc",
    kind: "bridge",
    usdc: 5,
    receivedUsdc: 4.952462,
    currency: "USDC",
    status: "completed",
    timestamp: 2_000,
    sourceChain: "base",
    destChain: "stellar",
    txHash: "0xabc",
    destTxHash: "stellarhash",
    route: "Base → Stellar",
    source: "server",
  });
});
