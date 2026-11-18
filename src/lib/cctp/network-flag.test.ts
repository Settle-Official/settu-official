import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// CCTP_NETWORK is read at import time, so each case runs in its own process.
function networkWith(env: Record<string, string>): string {
  const code =
    'import("./src/lib/cctp/constants.ts").then(m => process.stdout.write(m.CCTP_NETWORK))';
  const clean = { ...process.env };
  delete clean.CCTP_NETWORK;
  delete clean.NEXT_PUBLIC_CCTP_NETWORK;
  return execFileSync(
    process.execPath,
    ["--import", "./scripts/register-ts-resolver.mjs", "-e", code],
    { env: { ...clean, ...env }, encoding: "utf8" },
  );
}

test("the browser's NEXT_PUBLIC_CCTP_NETWORK=testnet selects testnet", () => {
  assert.equal(networkWith({ NEXT_PUBLIC_CCTP_NETWORK: "testnet" }), "testnet");
});

test("the server's CCTP_NETWORK still works, and unset means mainnet", () => {
  assert.equal(networkWith({ CCTP_NETWORK: "testnet" }), "testnet");
  assert.equal(networkWith({}), "mainnet");
});
