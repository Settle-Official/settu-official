import test from "node:test";
import assert from "node:assert/strict";
import { fetchCurrencies, fetchInstitutions, verifyAccount } from "./paycrest-directory";

function withFetch(impl: typeof globalThis.fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

test("fetchCurrencies returns the data array", async () => {
  await withFetch(
    async () => jsonResponse({ data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }] }),
    async () => {
      const currencies = await fetchCurrencies();
      assert.equal(currencies.length, 1);
      assert.equal(currencies[0].code, "NGN");
    },
  );
});

test("fetchCurrencies returns an empty array on a non-ok response", async () => {
  await withFetch(
    async () => jsonResponse({}, false),
    async () => assert.deepEqual(await fetchCurrencies(), []),
  );
});

test("fetchInstitutions hits the right URL and returns the data array", async () => {
  let requestedUrl = "";
  await withFetch(
    async (url) => {
      requestedUrl = String(url);
      return jsonResponse({ data: [{ code: "OPAYNGPC", name: "OPay" }] });
    },
    async () => {
      const institutions = await fetchInstitutions("NGN");
      assert.equal(institutions[0].name, "OPay");
      assert.match(requestedUrl, /\/institutions\/NGN$/);
    },
  );
});

test("verifyAccount returns the verified name", async () => {
  await withFetch(
    async () => jsonResponse({ data: { accountName: "JOHN DOE" } }),
    async () => {
      assert.equal(await verifyAccount("OPAYNGPC", "0987654321"), "JOHN DOE");
    },
  );
});

test("verifyAccount treats the literal 'OK' sentinel as unverifiable", async () => {
  await withFetch(
    async () => jsonResponse({ data: { accountName: "OK" } }),
    async () => {
      assert.equal(await verifyAccount("SOMEBANK", "0987654321"), null);
    },
  );
});

test("verifyAccount returns null on a network/HTTP failure", async () => {
  await withFetch(
    async () => jsonResponse({}, false),
    async () => assert.equal(await verifyAccount("SOMEBANK", "0987654321"), null),
  );
  await withFetch(
    async () => {
      throw new Error("network down");
    },
    async () => assert.equal(await verifyAccount("SOMEBANK", "0987654321"), null),
  );
});
