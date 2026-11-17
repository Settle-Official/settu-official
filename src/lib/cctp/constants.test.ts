import test from "node:test";
import assert from "node:assert/strict";
import { CCTP_DOMAIN, CCTP_CONFIG, STELLAR_USDC_DECIMALS, BASE_USDC_DECIMALS } from "./constants";

test("domains match Circle's published values", () => {
  assert.equal(CCTP_DOMAIN.stellar, 27);
  assert.equal(CCTP_DOMAIN.base, 6);
});

test("mainnet config has real, correctly-shaped addresses", () => {
  assert.match(CCTP_CONFIG.stellarTokenMessengerMinter, /^C[A-Z0-9]{55}$/);
  assert.match(CCTP_CONFIG.stellarUsdc, /^C[A-Z0-9]{55}$/);
  assert.match(CCTP_CONFIG.baseTokenMessengerV2, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(STELLAR_USDC_DECIMALS, 7);
  assert.equal(BASE_USDC_DECIMALS, 6);
});

import { CCTP_CONFIGS, EVM_MESSAGE_TRANSMITTER_V2_BY_NETWORK } from "./constants";

// Circle's raw docs, fetched 2026-11-17:
// https://developers.circle.com/cctp/references/contract-addresses.md
// MessageTransmitterV2 is the same address on all six EVM chains we use, per
// network. 0x8745D9… is TokenMessengerWithFees on testnet, not the transmitter.
test("MessageTransmitterV2 matches Circle's documented address on mainnet and testnet", () => {
  assert.equal(EVM_MESSAGE_TRANSMITTER_V2_BY_NETWORK.mainnet, "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64");
  assert.equal(EVM_MESSAGE_TRANSMITTER_V2_BY_NETWORK.testnet, "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275");
  assert.equal(CCTP_CONFIGS.mainnet.baseMessageTransmitterV2, EVM_MESSAGE_TRANSMITTER_V2_BY_NETWORK.mainnet);
  assert.equal(CCTP_CONFIGS.testnet.baseMessageTransmitterV2, EVM_MESSAGE_TRANSMITTER_V2_BY_NETWORK.testnet);
});
