import test from "node:test";
import assert from "node:assert/strict";
import { sourceChainOptions } from "./source-chain-options";

test("stellar is always first and always present", () => {
  const options = sourceChainOptions();
  assert.equal(options[0].code, "stellar");
  assert.equal(options[0].name, "Stellar");
});

test("every option has a non-empty code and name", () => {
  for (const option of sourceChainOptions()) {
    assert.ok(option.code.length > 0);
    assert.ok(option.name.length > 0);
  }
});
