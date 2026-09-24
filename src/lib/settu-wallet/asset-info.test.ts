import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { assess } from "./asset-info";
import { STELLAR_USDC_ISSUER } from "./account";

const STRANGER = Keypair.random().publicKey();

test("Circle's USDC is pinned regardless of what Horizon reports", () => {
  const result = assess("USDC", STELLAR_USDC_ISSUER, null, 0);
  assert.equal(result.isPinned, true);
  assert.equal(result.looksEstablished, true);
});

test("an impostor sharing the code is not pinned", () => {
  const result = assess("USDC", STRANGER, null, 3);
  assert.equal(result.isPinned, false);
  assert.equal(result.looksEstablished, false);
});

test("a widely held asset with a home domain reads as established", () => {
  const result = assess("EURC", STRANGER, "example.com", 50_000);
  assert.equal(result.looksEstablished, true);
});

test("holders alone are not enough without a home domain", () => {
  // Supply and holder counts are cheap to inflate; a domain is checkable.
  const result = assess("SCAM", STRANGER, null, 10_000_000);
  assert.equal(result.looksEstablished, false);
});

test("a home domain alone is not enough without holders", () => {
  const result = assess("NEW", STRANGER, "example.com", 4);
  assert.equal(result.looksEstablished, false);
});

test("the facts are always returned, so the UI can show them either way", () => {
  const result = assess("TEST", STRANGER, "example.com", 12);
  assert.equal(result.code, "TEST");
  assert.equal(result.issuer, STRANGER);
  assert.equal(result.homeDomain, "example.com");
  assert.equal(result.holders, 12);
});
