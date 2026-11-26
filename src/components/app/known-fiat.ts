// Kept in its own module so it can be unit-tested: useWalletHistory imports
// TransactionStorage at runtime through a "@/" alias, which the test runner's
// resolver only rewrites for relative specifiers.

/**
 * The payout, or undefined when it isn't known yet.
 *
 * The server writes destinationAmount "0" until settlement fills it in, and
 * "0" is not null — so `??` alone keeps the placeholder and discards the real
 * figure the local row captured at submit.
 */
export function knownFiat(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? value : undefined;
}
