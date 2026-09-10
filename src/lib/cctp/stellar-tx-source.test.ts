import test from "node:test";
import assert from "node:assert/strict";
import { resolveStellarTxSource } from "./stellar-tx-source";

const VALID_HASH = "a".repeat(64);

function withFetch(
  impl: typeof globalThis.fetch,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

test("returns the source account of a successful transaction", async () => {
  const source = `G${"A".repeat(55)}`;
  await withFetch(
    async () => jsonResponse({ successful: true, source_account: source }),
    async () => {
      assert.equal(await resolveStellarTxSource(VALID_HASH), source);
    },
  );
});

test("a failed transaction proves nothing, so attribution is refused", async () => {
  await withFetch(
    async () =>
      jsonResponse({ successful: false, source_account: `G${"A".repeat(55)}` }),
    async () => {
      assert.equal(await resolveStellarTxSource(VALID_HASH), null);
    },
  );
});

test("malformed hashes never reach the network", async () => {
  let called = false;
  await withFetch(
    async () => {
      called = true;
      return jsonResponse({});
    },
    async () => {
      for (const bad of ["", "xyz", "a".repeat(63), `${"a".repeat(64)}!`]) {
        assert.equal(await resolveStellarTxSource(bad), null);
      }
      assert.equal(called, false, "should not query Horizon for a bad hash");
    },
  );
});

test("an unknown hash or unreachable Horizon yields no attribution", async () => {
  await withFetch(
    async () => jsonResponse({}, false),
    async () => assert.equal(await resolveStellarTxSource(VALID_HASH), null),
  );
  await withFetch(
    async () => {
      throw new Error("network down");
    },
    async () => assert.equal(await resolveStellarTxSource(VALID_HASH), null),
  );
});

test("a source account that isn't a G-address is rejected", async () => {
  // Guards against crediting junk if Horizon ever returns an unexpected shape.
  for (const source of ["", "not-an-address", 42, null, `M${"A".repeat(55)}`]) {
    await withFetch(
      async () => jsonResponse({ successful: true, source_account: source }),
      async () => assert.equal(await resolveStellarTxSource(VALID_HASH), null),
    );
  }
});
