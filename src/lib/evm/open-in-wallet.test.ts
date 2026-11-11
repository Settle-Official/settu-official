import test from "node:test";
import assert from "node:assert/strict";
import { openInWalletLinks } from "./open-in-wallet";

test("openInWalletLinks builds each wallet's dapp deep link for the current page", () => {
  const links = Object.fromEntries(
    openInWalletLinks("https://www.settu.xyz/app/offramp?chain=base#x").map((l) => [l.id, l.href]),
  );
  assert.equal(links.metamask, "https://metamask.app.link/dapp/www.settu.xyz/app/offramp?chain=base");
  assert.equal(
    links.trust,
    "https://link.trustwallet.com/open_url?coin_id=60&url=https%3A%2F%2Fwww.settu.xyz%2Fapp%2Fofframp%3Fchain%3Dbase",
  );
  assert.equal(
    links.coinbase,
    "https://go.cb-w.com/dapp?cb_url=https%3A%2F%2Fwww.settu.xyz%2Fapp%2Fofframp%3Fchain%3Dbase",
  );
});
