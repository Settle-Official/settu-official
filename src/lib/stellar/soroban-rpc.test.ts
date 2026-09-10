import test from "node:test";
import assert from "node:assert/strict";
import { sorobanRpcEndpoints } from "./soroban-rpc";

const PUBLIC = "https://soroban-rpc.mainnet.stellar.gateway.fm";

function withEnv(
  env: Record<string, string | undefined>,
  fn: () => void,
): void {
  const keys = ["STELLAR_SOROBAN_RPC_URL", "STELLAR_SOROBAN_RPC_URL_FALLBACK"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("falls back to the public endpoint when nothing is configured", () => {
  withEnv({}, () => {
    assert.deepEqual(sorobanRpcEndpoints(), [PUBLIC]);
  });
});

test("primary comes first, public stays as last resort", () => {
  withEnv({ STELLAR_SOROBAN_RPC_URL: "https://rpc.example.com" }, () => {
    assert.deepEqual(sorobanRpcEndpoints(), ["https://rpc.example.com", PUBLIC]);
  });
});

test("comma-separated fallbacks are appended in order", () => {
  withEnv(
    {
      STELLAR_SOROBAN_RPC_URL: "https://a.example.com",
      STELLAR_SOROBAN_RPC_URL_FALLBACK: "https://b.example.com, https://c.example.com",
    },
    () => {
      assert.deepEqual(sorobanRpcEndpoints(), [
        "https://a.example.com",
        "https://b.example.com",
        "https://c.example.com",
        PUBLIC,
      ]);
    },
  );
});

test("de-dupes repeated endpoints and an explicit public primary", () => {
  withEnv(
    {
      STELLAR_SOROBAN_RPC_URL: PUBLIC,
      STELLAR_SOROBAN_RPC_URL_FALLBACK: `${PUBLIC}, https://d.example.com`,
    },
    () => {
      assert.deepEqual(sorobanRpcEndpoints(), [PUBLIC, "https://d.example.com"]);
    },
  );
});
