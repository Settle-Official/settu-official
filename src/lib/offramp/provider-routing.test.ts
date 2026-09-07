import test from "node:test";
import assert from "node:assert/strict";

import {
  selectTopProviders,
  PROVIDER_QUEUE_LIMIT,
  DEFAULT_MIN_SUCCESS_PERCENT,
} from "./provider-routing";
import type { MarketOffer, MarketSide } from "./types";

// Fixture mirrors a real `GET /v2/markets?side=sell&fiat=NGN&token=USDC&network=base`
// response: 16 tiers across 5 distinct providers, with one provider (MKgxdEsQ)
// publishing four separate bands.
function offer(
  providerId: string,
  rate: string,
  min: string,
  max: string,
  balance: string,
  successPercent: string | null,
  settled = 100,
  overrides: Partial<MarketOffer> = {},
): MarketOffer {
  return {
    providerId,
    side: "sell",
    token: "USDC",
    fiat: "NGN",
    network: "base",
    rate,
    rateType: "floating",
    min,
    max,
    balance,
    balanceCurrency: "NGN",
    balanceUsd: "0",
    settled,
    successPercent,
    ...overrides,
  };
}

const BOOK: MarketOffer[] = [
  offer("MKgxdEsQ", "1360.32", "100", "1000", "948775.07", "98.42", 2431),
  offer("MKgxdEsQ", "1360.32", "1001", "3000", "948775.07", "98.42", 2431),
  offer("WYjUQLBk", "1360.32", "101", "500", "1075728.81", "98.23", 9425),
  offer("hvMxgGXM", "1360.32", "500", "2000", "212206.98", "97.18", 414),
  offer("FZvfAEyg", "1360.32", "100.000999", "249", "112072.18", "98.43", 2322),
  offer("FZvfAEyg", "1360.32", "250.000999", "400", "112072.18", "98.43", 2322),
  offer("FZvfAEyg", "1360.32", "400.000999", "2000", "112072.18", "98.43", 2322),
  offer("WYjUQLBk", "1359.72", "30", "100.99", "1075728.81", "98.23", 9425),
  offer("kVMyxKfB", "1359.32", "250", "2000", "327853956.26", "95.67", 4485),
  offer("MKgxdEsQ", "1359.32", "31", "99", "948775.07", "98.42", 2431),
  offer("FZvfAEyg", "1359.32", "50.000999", "99.9", "112072.18", "98.43", 2322),
  offer("etoMCRIY", "1359.32", "0.5", "7000", "40384523.21", "90.11", 4410),
  offer("MKgxdEsQ", "1358.32", "5", "30", "948775.07", "98.42", 2431),
  offer("FZvfAEyg", "1358.32", "30.000999", "50", "112072.18", "98.43", 2322),
  offer("WYjUQLBk", "1358.12", "5", "29.99", "1075728.81", "98.23", 9425),
  offer("FZvfAEyg", "1354.32", "10.000999", "30", "112072.18", "98.43", 2322),
];

const BASE_OPTS = {
  side: "sell" as MarketSide,
  fiat: "NGN",
  token: "USDC",
  network: "base",
};

function shuffle<T>(items: T[], seed = 7): T[] {
  // Deterministic LCG shuffle so a failure is reproducible.
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test("returns three distinct providers, never the same one twice", () => {
  const result = selectTopProviders(BOOK, { ...BASE_OPTS, amount: 500 });

  assert.equal(result.providerIds.length, PROVIDER_QUEUE_LIMIT);
  assert.equal(
    new Set(result.providerIds).size,
    PROVIDER_QUEUE_LIMIT,
    "queue must not repeat a provider — that would be one point of failure, not three",
  );
});

test("phase ordering: best rate does not rescue a provider whose band excludes the amount", () => {
  // Top of the book by rate, but only fills 5-10 USDC.
  const book = [
    ...BOOK,
    offer("NARROW01", "9999.99", "5", "10", "999999999", "99.99", 5000),
  ];
  const result = selectTopProviders(book, { ...BASE_OPTS, amount: 500 });

  assert.ok(
    !result.providerIds.includes("NARROW01"),
    "a provider that cannot settle the amount must be filtered out before ranking",
  );
  assert.equal(result.rate, 1360.32);
});

test("phase ordering: best rate does not rescue a provider with insufficient balance", () => {
  // Band covers the amount and the rate is unbeatable, but it can only pay 100 NGN.
  const book = [
    ...BOOK,
    offer("BROKE001", "9999.99", "1", "5000", "100", "99.99", 5000),
  ];
  const result = selectTopProviders(book, { ...BASE_OPTS, amount: 500 });

  assert.ok(
    !result.providerIds.includes("BROKE001"),
    "liquidity is a capability gate, not a ranking penalty",
  );
  assert.equal(result.rate, 1360.32);
});

test("picks the tier whose band contains the amount, not another band of the same provider", () => {
  const result = selectTopProviders(BOOK, { ...BASE_OPTS, amount: 500 });
  const mk = result.offers.find((o) => o.providerId === "MKgxdEsQ");

  assert.ok(mk, "MKgxdEsQ should qualify at 500");
  assert.equal(mk.min, "100");
  assert.equal(mk.max, "1000");
});

test("excludes providers whose bands top out below the amount", () => {
  const result = selectTopProviders(BOOK, { ...BASE_OPTS, amount: 2500 });

  // Only MKgxdEsQ (1001-3000) and etoMCRIY (0.5-7000) have a band covering 2500,
  // and MKgxdEsQ is then dropped on liquidity: 2500 * 1360.32 = 3,400,800 NGN
  // needed against a 948,775 NGN balance. Both gates are doing work here.
  assert.deepEqual(result.providerIds, ["etoMCRIY"]);
  assert.ok(!result.providerIds.includes("WYjUQLBk"), "band tops out at 500");
  assert.ok(!result.providerIds.includes("hvMxgGXM"), "band tops out at 2000");
});

test("rate ties break by successPercent, then settled, then providerId", () => {
  const book = [
    offer("bbb", "1000", "1", "5000", "99999999", "95.00", 100),
    offer("aaa", "1000", "1", "5000", "99999999", "95.00", 100),
    offer("ccc", "1000", "1", "5000", "99999999", "95.00", 900),
    offer("ddd", "1000", "1", "5000", "99999999", "99.00", 100),
  ];
  const result = selectTopProviders(book, { ...BASE_OPTS, amount: 100, limit: 4 });

  // ddd: highest success. ccc: same success as aaa/bbb but more settled.
  // aaa before bbb: alphabetical final key.
  assert.deepEqual(result.providerIds, ["ddd", "ccc", "aaa", "bbb"]);
});

test("ordering is stable regardless of the order the API returned rows in", () => {
  const expected = selectTopProviders(BOOK, { ...BASE_OPTS, amount: 500 }).providerIds;

  for (let seed = 1; seed <= 5; seed++) {
    const result = selectTopProviders(shuffle(BOOK, seed), {
      ...BASE_OPTS,
      amount: 500,
    });
    assert.deepEqual(result.providerIds, expected, `unstable for seed ${seed}`);
  }
});

test("drops a provider whose balance cannot cover amount * rate", () => {
  // 10 USDC * 1400 = 14,000 NGN required; provider holds 13,999.
  const book = [offer("THIN0001", "1400", "1", "100", "13999", "99.00")];
  assert.deepEqual(
    selectTopProviders(book, { ...BASE_OPTS, amount: 10 }).providerIds,
    [],
  );

  const funded = [offer("THIN0001", "1400", "1", "100", "14000", "99.00")];
  assert.deepEqual(
    selectTopProviders(funded, { ...BASE_OPTS, amount: 10 }).providerIds,
    ["THIN0001"],
  );
});

test("a null successPercent fails the floor", () => {
  const book = [
    offer("NOHIST01", "1400", "1", "100", "99999999", null),
    offer("HASHIST1", "1300", "1", "100", "99999999", "95.00"),
  ];
  const result = selectTopProviders(book, { ...BASE_OPTS, amount: 10 });

  assert.deepEqual(result.providerIds, ["HASHIST1"]);
  assert.equal(result.relaxedSuccessFloor, false);
});

test("relaxes the success floor rather than returning nothing", () => {
  const book = [
    offer("WEAK0001", "1400", "1", "100", "99999999", "40.00"),
    offer("WEAK0002", "1300", "1", "100", "99999999", null),
  ];
  const result = selectTopProviders(book, { ...BASE_OPTS, amount: 10 });

  assert.equal(result.relaxedSuccessFloor, true);
  assert.deepEqual(result.providerIds, ["WEAK0001", "WEAK0002"]);
  assert.ok(DEFAULT_MIN_SUCCESS_PERCENT > 40);
});

test("empty and malformed books return an empty selection instead of throwing", () => {
  for (const book of [
    [],
    undefined as unknown as MarketOffer[],
    [offer("BAD00001", "not-a-number", "1", "100", "99999999", "99.00")],
    [offer("BAD00002", "1400", "abc", "xyz", "99999999", "99.00")],
    [offer("BAD00003", "1400", "1", "100", "not-a-balance", "99.00")],
  ]) {
    const result = selectTopProviders(book, { ...BASE_OPTS, amount: 10 });
    assert.deepEqual(result.providerIds, []);
    assert.equal(result.rate, 0);
  }
});

test("ignores rows from other corridors in the same book", () => {
  const book = [
    offer("NGNONLY1", "1400", "1", "100", "99999999", "99.00"),
    offer("KESONLY1", "129", "1", "100", "99999999", "99.00", 100, {
      fiat: "KES",
      balanceCurrency: "KES",
    }),
    offer("USDTONLY", "1450", "1", "100", "99999999", "99.00", 100, {
      token: "USDT",
    }),
    offer("POLYONLY", "1500", "1", "100", "99999999", "99.00", 100, {
      network: "polygon",
    }),
    offer("BUYSIDE1", "1600", "1", "100", "99999999", "99.00", 100, {
      side: "buy",
    }),
  ];
  const result = selectTopProviders(book, { ...BASE_OPTS, amount: 10 });

  assert.deepEqual(result.providerIds, ["NGNONLY1"]);
});

test("buy side ranks by lowest rate", () => {
  const book: MarketOffer[] = [
    offer("EXPENSIV", "1500", "1", "1000", "99999999", "99.00", 100, { side: "buy" }),
    offer("CHEAPEST", "1400", "1", "1000", "99999999", "99.00", 100, { side: "buy" }),
    offer("MIDPRICE", "1450", "1", "1000", "99999999", "99.00", 100, { side: "buy" }),
  ];
  const result = selectTopProviders(book, {
    ...BASE_OPTS,
    side: "buy",
    amount: 10,
  });

  assert.deepEqual(result.providerIds, ["CHEAPEST", "MIDPRICE", "EXPENSIV"]);
  assert.equal(result.rate, 1400);
});

test("respects an explicit limit", () => {
  const result = selectTopProviders(BOOK, { ...BASE_OPTS, amount: 500, limit: 1 });
  assert.equal(result.providerIds.length, 1);
});

test("a non-positive amount selects nothing", () => {
  for (const amount of [0, -5, Number.NaN]) {
    assert.deepEqual(
      selectTopProviders(BOOK, { ...BASE_OPTS, amount }).providerIds,
      [],
    );
  }
});
