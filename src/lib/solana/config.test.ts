import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  SOLANA_CONFIG,
  SOLANA_CCTP_DOMAIN,
  isSolanaEnabled,
} from "./config";

test("Solana CCTP domain is 5", () => {
  assert.equal(SOLANA_CCTP_DOMAIN, 5);
  assert.equal(SOLANA_CONFIG.cctpDomain, 5);
});

test("USDC on Solana is 6 decimals", () => {
  assert.equal(SOLANA_CONFIG.usdcDecimals, 6);
});

test("program IDs + USDC mint are valid base58 pubkeys", () => {
  for (const [name, addr] of Object.entries({
    messageTransmitterV2: SOLANA_CONFIG.messageTransmitterV2,
    tokenMessengerMinterV2: SOLANA_CONFIG.tokenMessengerMinterV2,
    usdcMint: SOLANA_CONFIG.usdcMint,
  })) {
    assert.doesNotThrow(() => new PublicKey(addr), `${name} = ${addr}`);
  }
});

test("program IDs match the vendored on-chain IDL address field", async () => {
  const mt = await import("./idl/message_transmitter_v2.json", {
    with: { type: "json" },
  });
  const tmm = await import("./idl/token_messenger_minter_v2.json", {
    with: { type: "json" },
  });
  assert.equal(SOLANA_CONFIG.messageTransmitterV2, (mt.default as any).address);
  assert.equal(
    SOLANA_CONFIG.tokenMessengerMinterV2,
    (tmm.default as any).address,
  );
});

test("isSolanaEnabled reads the offramp source allowlist", () => {
  const prev = process.env.NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED;
  try {
    process.env.NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED = "arbitrum,solana";
    assert.equal(isSolanaEnabled(), true);
    process.env.NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED = "arbitrum,base";
    assert.equal(isSolanaEnabled(), false);
    delete process.env.NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED;
    assert.equal(isSolanaEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED;
    else process.env.NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED = prev;
  }
});
