import { test } from "node:test";
import assert from "node:assert/strict";
import { gasLevel, gasAlertMessage } from "./gas-alert";

test("gasLevel: ok at or above warn, low between floor and warn, empty below floor", () => {
  assert.equal(gasLevel(0.004, 0.0005, 0.003), "ok");
  assert.equal(gasLevel(0.003, 0.0005, 0.003), "ok");
  assert.equal(gasLevel(0.0009, 0.0005, 0.003), "low");
  assert.equal(gasLevel(0.0005, 0.0005, 0.003), "low");
  assert.equal(gasLevel(0.0004997, 0.0005, 0.003), "empty");
});

test("gasAlertMessage names the wallet, balance and top-up address", () => {
  const reading = {
    wallet: "Base relayer",
    address: "0xAca2F58f87286E9718D8133c469FA1eD57F3FCa3",
    unit: "ETH" as const,
    balance: 0.0009,
    floor: 0.0005,
    warn: 0.003,
  };
  const low = gasAlertMessage(reading, "low");
  assert.match(low, /running low/);
  assert.match(low, /0\.0009 ETH/);
  assert.match(low, /0xAca2F58f87286E9718D8133c469FA1eD57F3FCa3/);
  assert.doesNotMatch(low, /revive/);

  const empty = gasAlertMessage({ ...reading, balance: 0.0004 }, "empty");
  assert.match(empty, /refused/);
  assert.match(empty, /revive/);
});
