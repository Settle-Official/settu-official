import test from "node:test";
import assert from "node:assert/strict";

import {
  usdcToFiat,
  fiatToUsdc,
  minFiatFor,
  solveUsdcForFiat,
  roundUpTo,
  MIN_USDC_AMOUNT,
  PLATFORM_FEE_RATE,
  DEFAULT_FIAT_MIN_STEP,
} from "./fiat-conversion";

// Live rates at the time of writing, used so the minimums assert against real
// corridor numbers rather than invented ones.
const RATE = { NGN: 1361.9, KES: 128.57, UGX: 3753.68, TZS: 2612.05 };

test("forward conversion applies bridge fee then rate then platform fee", () => {
  // bps = 0 is what Circle currently returns for Stellar->Base fast transfer.
  assert.equal(usdcToFiat(5, 1000, 0), 5 * 1000 * 0.997);
  // 13 bps = 0.13% off the top, before the rate.
  assert.equal(usdcToFiat(5, 1000, 13), 5 * (1 - 0.0013) * 1000 * 0.997);
});

test("platform fee is 0.3%, matching what Paycrest deducts", () => {
  assert.equal(PLATFORM_FEE_RATE, 0.003);
  assert.equal(usdcToFiat(100, 1, 0), 99.7);
});

test("round-trip usdc -> fiat -> usdc is stable and never short", () => {
  for (const bps of [0, 1.3, 13]) {
    for (const usdc of [0.7, 1, 5.5, 137.25, 2000]) {
      const fiat = usdcToFiat(usdc, RATE.NGN, bps);
      const back = fiatToUsdc(fiat, RATE.NGN, bps);
      // Rounding up to 6dp may add at most one atomic unit.
      assert.ok(
        back >= usdc - 1e-9,
        `bps=${bps} usdc=${usdc}: ${back} < ${usdc}`,
      );
      assert.ok(back - usdc < 1e-5, `bps=${bps} usdc=${usdc} drifted: ${back}`);
    }
  }
});

test("fiatToUsdc rounds up so the user is never under-credited", () => {
  const bps = 0;
  for (const fiat of [1000, 50000, 12345.67]) {
    const usdc = fiatToUsdc(fiat, RATE.NGN, bps);
    assert.ok(
      usdcToFiat(usdc, RATE.NGN, bps) >= fiat,
      `${fiat} NGN -> ${usdc} USDC delivered less than asked`,
    );
    // No more than 6dp of precision.
    assert.equal(usdc, roundUpTo(usdc, 6));
  }
});

test("minFiatFor gives the intended per-corridor minimums", () => {
  assert.equal(minFiatFor("NGN", RATE.NGN, 0), 1000);
  assert.equal(minFiatFor("KES", RATE.KES, 0), 100);
  assert.equal(minFiatFor("UGX", RATE.UGX, 0), 3000);
  assert.equal(minFiatFor("TZS", RATE.TZS, 0), 2000);
});

test("every corridor minimum stays close to the USDC floor", () => {
  for (const [cur, rate] of Object.entries(RATE)) {
    const usdc = fiatToUsdc(minFiatFor(cur, rate, 0), rate, 0);
    assert.ok(
      usdc >= MIN_USDC_AMOUNT && usdc < MIN_USDC_AMOUNT * 1.5,
      `${cur} minimum is ${usdc} USDC, outside the intended band`,
    );
  }
});

test("an unknown currency falls back to the default step", () => {
  // 0.7 * 500 * 0.997 = 348.95 -> next 100 = 400
  assert.equal(DEFAULT_FIAT_MIN_STEP, 100);
  assert.equal(minFiatFor("XOF", 500, 0), 400);
});

test("currency matching is case-insensitive", () => {
  assert.equal(minFiatFor("ngn", RATE.NGN, 0), minFiatFor("NGN", RATE.NGN, 0));
});

test("solve converges immediately when the rate is amount-independent", () => {
  const result = solveUsdcForFiat(50000, {
    resolveRate: () => RATE.NGN,
    bridgeBps: 0,
  });

  assert.ok(result.converged);
  assert.equal(result.rate, RATE.NGN);
  assert.ok(usdcToFiat(result.usdc, result.rate, 0) >= 50000);
});

test("solve re-prices across a tier boundary — the case it exists for", () => {
  // Mirrors the real book: a low band at a worse rate, a higher band at a
  // better one. Seeded at MIN_USDC_AMOUNT the solve starts in the low band and
  // must climb into the high band and re-solve.
  const resolveRate = (usdc: number) => (usdc < 100 ? 1300 : 1360);

  const result = solveUsdcForFiat(200_000, { resolveRate, bridgeBps: 0 });

  assert.ok(result.converged, "should settle in the 1360 band");
  assert.equal(result.rate, 1360);
  // A single division at the seed rate would have used 1300 and overcharged.
  const naive = fiatToUsdc(200_000, 1300, 0);
  assert.ok(
    result.usdc < naive,
    `solve (${result.usdc}) should beat the naive seed-rate answer (${naive})`,
  );
  assert.ok(usdcToFiat(result.usdc, result.rate, 0) >= 200_000);
});

test("solve reports non-convergence on an oscillating boundary", () => {
  // Band edge at 150 USDC, with the *upper* band paying better. Solving at the
  // low rate lands above 150; solving at the high rate lands below it — so the
  // answer flips back and forth and never settles.
  //   200000 / (1300 * 0.997) = 154.3  -> upper band
  //   200000 / (1400 * 0.997) = 143.3  -> lower band
  const resolveRate = (usdc: number) => (usdc < 150 ? 1300 : 1400);

  const result = solveUsdcForFiat(200_000, {
    resolveRate,
    bridgeBps: 0,
    maxIterations: 4,
  });

  assert.equal(result.converged, false);
  assert.ok(result.iterations > 4);
  // Still returns a usable pair rather than throwing or zeroing.
  assert.ok(result.usdc > 0 && result.rate > 0);
});

test("solve keeps the last workable rate when no band covers the amount", () => {
  let calls = 0;
  const resolveRate = (usdc: number) => {
    calls++;
    return usdc < 10 ? 1360 : 0; // nothing quotes above 10 USDC
  };

  const result = solveUsdcForFiat(500_000, { resolveRate, bridgeBps: 0 });

  assert.ok(calls >= 2);
  assert.equal(result.rate, 1360);
  assert.ok(result.usdc > 0);
});

test("solve honours the bridge fee", () => {
  const withFee = solveUsdcForFiat(50_000, {
    resolveRate: () => RATE.NGN,
    bridgeBps: 13,
  });
  const withoutFee = solveUsdcForFiat(50_000, {
    resolveRate: () => RATE.NGN,
    bridgeBps: 0,
  });

  assert.ok(
    withFee.usdc > withoutFee.usdc,
    "a bridge fee must require more USDC for the same fiat",
  );
});

test("non-positive and malformed inputs return zero rather than throwing", () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(usdcToFiat(bad, RATE.NGN, 0), 0);
    assert.equal(fiatToUsdc(bad, RATE.NGN, 0), 0);
    assert.equal(minFiatFor("NGN", bad, 0), 0);
    assert.deepEqual(
      solveUsdcForFiat(bad, { resolveRate: () => RATE.NGN, bridgeBps: 0 }),
      { usdc: 0, rate: 0, iterations: 0, converged: false },
    );
  }
  // A rate of zero is equally unusable.
  assert.equal(usdcToFiat(5, 0, 0), 0);
  assert.equal(fiatToUsdc(5000, 0, 0), 0);
});

test("solve returns empty when the book quotes nothing at all", () => {
  assert.deepEqual(
    solveUsdcForFiat(50_000, { resolveRate: () => 0, bridgeBps: 0 }),
    { usdc: 0, rate: 0, iterations: 0, converged: false },
  );
});
