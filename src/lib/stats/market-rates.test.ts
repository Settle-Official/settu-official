import test from "node:test";
import assert from "node:assert/strict";

import { MARKETS, bestSellRate, formatRate } from "./market-rates";

test("picks the highest rate in the book", () => {
  const payload = { data: { book: [{ rate: "1428.21" }, { rate: "1431.5" }, { rate: "1390" }] } };
  assert.equal(bestSellRate(payload), 1431.5);
});

test("no providers quoting → null, never zero", () => {
  assert.equal(bestSellRate({ data: { book: [] } }), null);
  assert.equal(bestSellRate({ data: {} }), null);
  assert.equal(bestSellRate(null), null);
  assert.equal(bestSellRate({ data: { book: [{ rate: "abc" }, { rate: "-3" }] } }), null);
});

test("formats whole units for large rates and cents for small ones", () => {
  assert.equal(formatRate({ symbol: "₦" }, 1428.21), "₦1,428");
  assert.equal(formatRate({ symbol: "GH₵" }, 12.11), "GH₵12.11");
  assert.equal(formatRate({ symbol: "TSh" }, 2721), "TSh2,721");
});

test("covers the seven Paycrest markets, each with a flag", () => {
  assert.deepEqual(MARKETS.map((m) => m.code), ["NGN", "GHS", "KES", "TZS", "RWF", "UGX", "ZMW"]);
  for (const m of MARKETS) assert.match(m.flag, /^[a-z]{2}$/);
});
