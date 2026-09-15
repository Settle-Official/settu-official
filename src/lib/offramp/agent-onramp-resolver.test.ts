import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyOnrampExtraction,
  resolveOnrampOrder,
  type OnrampAgentExtraction,
} from "./agent-onramp-resolver";

const COMPLETE: OnrampAgentExtraction = {
  fiatAmount: "100000",
  fiatCurrency: "NGN",
  destinationStellarAddress:
    "GALC4XJL55YPA7WLS3VDK3IOZDQ4LF5ZXO422EJZ34MPFI44NPXZOQCR",
  refundInstitutionName: "OPay",
  refundAccountIdentifier: "0987654321",
};

test("classifyOnrampExtraction: fully populated is complete", () => {
  assert.equal(classifyOnrampExtraction(COMPLETE).status, "complete");
});

test("classifyOnrampExtraction: one missing field asks a targeted question, not a recap", () => {
  const result = classifyOnrampExtraction({
    ...COMPLETE,
    refundAccountIdentifier: null,
  });
  assert.equal(result.status, "clarify");
  if (result.status === "clarify") {
    assert.match(result.message, /account number/i);
  }
});

test("classifyOnrampExtraction: three or more missing fields is a recap, not a question", () => {
  const result = classifyOnrampExtraction({
    ...COMPLETE,
    refundAccountIdentifier: null,
    fiatAmount: null,
    destinationStellarAddress: null,
  });
  assert.equal(result.status, "recap");
  if (result.status === "recap") {
    assert.equal(result.missing.length, 3);
  }
});

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
  return { ok, json: async () => body } as Response;
}

test("resolveOnrampOrder: happy path resolves with the verified name and real institution code", async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/currencies")) {
        return jsonResponse({
          data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }],
        });
      }
      if (u.includes("/institutions/")) {
        return jsonResponse({ data: [{ code: "OPAYNGPC", name: "OPay" }] });
      }
      if (u.includes("/verify-account")) {
        return jsonResponse({ data: { accountName: "JOHN DOE" } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
    async () => {
      const result = await resolveOnrampOrder(COMPLETE);
      assert.equal(result.status, "resolved");
      if (result.status === "resolved") {
        assert.equal(result.order.fiatAmount, "100000");
        assert.equal(result.order.currency, "NGN");
        assert.equal(
          result.order.destinationAddress,
          "GALC4XJL55YPA7WLS3VDK3IOZDQ4LF5ZXO422EJZ34MPFI44NPXZOQCR",
        );
        assert.equal(result.order.refundAccount.institution, "OPAYNGPC");
        assert.equal(result.order.refundAccount.accountName, "JOHN DOE");
      }
    },
  );
});

test("resolveOnrampOrder: a bank nickname alias (GTBank) still resolves", async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/currencies")) {
        return jsonResponse({
          data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }],
        });
      }
      if (u.includes("/institutions/")) {
        return jsonResponse({
          data: [{ code: "GTBINGLA", name: "Guaranty Trust Bank" }],
        });
      }
      if (u.includes("/verify-account")) {
        return jsonResponse({ data: { accountName: "JANE DOE" } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
    async () => {
      const result = await resolveOnrampOrder({
        ...COMPLETE,
        refundInstitutionName: "GTBank",
      });
      assert.equal(result.status, "resolved");
      if (result.status === "resolved") {
        assert.equal(result.order.refundAccount.institution, "GTBINGLA");
      }
    },
  );
});

test("resolveOnrampOrder: an invalid Stellar address asks for a valid one", async () => {
  const result = await resolveOnrampOrder({
    ...COMPLETE,
    destinationStellarAddress: "not-a-real-address",
  });
  assert.equal(result.status, "clarify");
  if (result.status === "clarify") {
    assert.match(result.message, /stellar address/i);
  }
});

test("resolveOnrampOrder: unsupported currency asks for a different one", async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/currencies")) {
        return jsonResponse({
          data: [{ code: "KES", name: "Kenyan Shilling", symbol: "KSh" }],
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
    async () => {
      const result = await resolveOnrampOrder(COMPLETE);
      assert.equal(result.status, "clarify");
      if (result.status === "clarify") {
        assert.match(result.message, /NGN|currency|support/i);
      }
    },
  );
});

test("resolveOnrampOrder: unresolvable refund bank asks which bank, not a guess", async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/currencies")) {
        return jsonResponse({
          data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }],
        });
      }
      if (u.includes("/institutions/")) {
        return jsonResponse({ data: [{ code: "OPAYNGPC", name: "OPay" }] });
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
    async () => {
      const result = await resolveOnrampOrder({
        ...COMPLETE,
        refundInstitutionName: "SomeBankThatDoesNotExist",
      });
      assert.equal(result.status, "clarify");
      if (result.status === "clarify") assert.match(result.message, /bank/i);
    },
  );
});

test("resolveOnrampOrder: 'connected' sentinel resolves to the client's connected Stellar wallet", async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/currencies")) {
        return jsonResponse({
          data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }],
        });
      }
      if (u.includes("/institutions/")) {
        return jsonResponse({ data: [{ code: "OPAYNGPC", name: "OPay" }] });
      }
      if (u.includes("/verify-account")) {
        return jsonResponse({ data: { accountName: "JOHN DOE" } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
    async () => {
      const result = await resolveOnrampOrder(
        { ...COMPLETE, destinationStellarAddress: "connected" },
        {
          connectedStellarAddress:
            "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
        },
      );
      assert.equal(result.status, "resolved");
      if (result.status === "resolved") {
        assert.equal(
          result.order.destinationAddress,
          "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
        );
      }
    },
  );
});

test("resolveOnrampOrder: 'connected' sentinel with no wallet connected asks the user to connect or give an address", async () => {
  const result = await resolveOnrampOrder(
    { ...COMPLETE, destinationStellarAddress: "connected" },
    { connectedStellarAddress: null },
  );
  assert.equal(result.status, "clarify");
  if (result.status === "clarify") {
    assert.match(result.message, /connect|address/i);
  }
});

test("resolveOnrampOrder: 'connected' sentinel is case-insensitive and trims whitespace", async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/currencies")) {
        return jsonResponse({
          data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }],
        });
      }
      if (u.includes("/institutions/")) {
        return jsonResponse({ data: [{ code: "OPAYNGPC", name: "OPay" }] });
      }
      if (u.includes("/verify-account")) {
        return jsonResponse({ data: { accountName: "JOHN DOE" } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
    async () => {
      const result = await resolveOnrampOrder(
        { ...COMPLETE, destinationStellarAddress: " Connected " },
        {
          connectedStellarAddress:
            "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
        },
      );
      assert.equal(result.status, "resolved");
    },
  );
});

test("resolveOnrampOrder: a KES 'OK' refund verify-account response still resolves, falling back to the account number", async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/currencies")) {
        return jsonResponse({
          data: [{ code: "KES", name: "Kenyan Shilling", symbol: "KSh" }],
        });
      }
      if (u.includes("/institutions/")) {
        return jsonResponse({ data: [{ code: "MPESAKE", name: "M-Pesa" }] });
      }
      if (u.includes("/verify-account")) return jsonResponse({ data: "OK" });
      throw new Error(`unexpected fetch: ${u}`);
    },
    async () => {
      const result = await resolveOnrampOrder({
        ...COMPLETE,
        fiatCurrency: "KES",
        refundInstitutionName: "M-Pesa",
      });
      assert.equal(result.status, "resolved");
      if (result.status === "resolved") {
        assert.equal(
          result.order.refundAccount.accountName,
          COMPLETE.refundAccountIdentifier,
        );
      }
    },
  );
});

test("resolveOnrampOrder: an 'OK' refund verify-account response for NGN is still treated as unverified", async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/currencies")) {
        return jsonResponse({
          data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }],
        });
      }
      if (u.includes("/institutions/")) {
        return jsonResponse({ data: [{ code: "OPAYNGPC", name: "OPay" }] });
      }
      if (u.includes("/verify-account")) return jsonResponse({ data: "OK" });
      throw new Error(`unexpected fetch: ${u}`);
    },
    async () => {
      const result = await resolveOnrampOrder(COMPLETE);
      assert.equal(result.status, "clarify");
      if (result.status === "clarify") {
        assert.match(result.message, /account number/i);
      }
    },
  );
});

test("resolveOnrampOrder: failed refund-account verification asks to double check the number", async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/currencies")) {
        return jsonResponse({
          data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }],
        });
      }
      if (u.includes("/institutions/")) {
        return jsonResponse({ data: [{ code: "OPAYNGPC", name: "OPay" }] });
      }
      if (u.includes("/verify-account")) return jsonResponse({}, false);
      throw new Error(`unexpected fetch: ${u}`);
    },
    async () => {
      const result = await resolveOnrampOrder(COMPLETE);
      assert.equal(result.status, "clarify");
      if (result.status === "clarify") {
        assert.match(result.message, /account number/i);
      }
    },
  );
});
