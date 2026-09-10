import test from "node:test";
import assert from "node:assert/strict";
import { SOLANA_MOBILE_WALLETS } from "./mobile-deeplinks";

const PAGE = "https://www.settu.xyz/account?tab=wallets";

function linkFor(name: string): string {
  const wallet = SOLANA_MOBILE_WALLETS.find((w) => w.name === name);
  assert.ok(wallet, `${name} missing`);
  return wallet.href(PAGE);
}

test("matches the templates in each wallet's official docs", () => {
  assert.ok(linkFor("Phantom").startsWith("https://phantom.app/ul/browse/"));
  assert.ok(linkFor("Solflare").startsWith("https://solflare.com/ul/v1/browse/"));
});

test("the target URL is encoded, not interpolated raw", () => {
  // Unencoded, the query string of the target would merge into the deeplink's
  // own and the wallet would open the wrong page.
  for (const wallet of SOLANA_MOBILE_WALLETS) {
    const link = wallet.href(PAGE);
    assert.ok(link.includes(encodeURIComponent(PAGE)), `${wallet.name} not encoded`);
    assert.ok(!link.includes("?tab=wallets"), `${wallet.name} leaked a raw query`);
  }
});

test("ref carries the origin, encoded", () => {
  for (const wallet of SOLANA_MOBILE_WALLETS) {
    assert.ok(
      wallet.href(PAGE).endsWith(`ref=${encodeURIComponent("https://www.settu.xyz")}`),
      `${wallet.name} ref wrong`,
    );
  }
});

test("an unparseable url still produces a link rather than throwing", () => {
  for (const wallet of SOLANA_MOBILE_WALLETS) {
    assert.doesNotThrow(() => wallet.href("not-a-url"));
  }
});
