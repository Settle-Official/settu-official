import test from "node:test";
import assert from "node:assert/strict";
import { ageLabel, nativeAmount, pillStatus, recipientView, shouldPoll, usdc } from "./explorer-format";

test("amounts format as USDC up to 6 decimals; native uses its own symbol", () => {
  assert.equal(usdc("1234567"), "1.234567");
  assert.equal(usdc("1000000"), "1");
  assert.equal(usdc("500"), "0.0005");
  assert.equal(nativeAmount("1500000000000000", 18, "ETH"), "0.0015 ETH");
});

test("recipient: real address, token-account tag, unknown label", () => {
  assert.deepEqual(recipientView({ recipient: "0xabc" }), { text: "0xabc" });
  assert.deepEqual(recipientView({ recipient: "Ata1", recipientIsTokenAccount: true }), {
    text: "Ata1",
    tag: "token account",
  });
  assert.deepEqual(recipientView({ recipientUnknown: true }), {
    text: "Unknown (recovered by sweep)",
    unknown: true,
  });
});

test("pill shows Stuck over stage; polling only when visible", () => {
  assert.equal(pillStatus({ status: "delivering", stuck: true }), "stuck");
  assert.equal(pillStatus({ status: "completed", stuck: false }), "completed");
  assert.equal(shouldPoll("visible"), true);
  assert.equal(shouldPoll("hidden"), false);
  assert.equal(ageLabel(90_000), "1m");
});
