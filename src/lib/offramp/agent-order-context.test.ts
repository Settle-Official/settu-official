import test from "node:test";
import assert from "node:assert/strict";
import { summarizeOrder, mergeRepeat, type CompletedOrder } from "./agent-order-context";

const COMPLETED_OFFRAMP: CompletedOrder = {
  direction: "offramp",
  amount: "500",
  token: "USDC",
  sourceChain: "base",
  beneficiary: { institution: "GTBNGPC", accountIdentifier: "0123456789", currency: "NGN" },
};

const COMPLETED_ONRAMP: CompletedOrder = {
  direction: "onramp",
  fiatAmount: "50000",
  currency: "NGN",
  destinationAddress: "GALC4Z2SEP2VZONZ6VBSTZ4XZOQCRHVKJ4T3N7YOHOZ6JXZOQCR",
  refundAccount: { institution: "OPAYNGPC", accountIdentifier: "0987654321" },
};

const EMPTY_EXTRACTION = {
  intent: "repeat" as const,
  direction: null,
  amount: null,
  token: null,
  sourceChain: null,
  destinationCurrency: null,
  institutionName: null,
  accountIdentifier: null,
  fiatAmount: null,
  fiatCurrency: null,
  destinationStellarAddress: null,
  refundInstitutionName: null,
  refundAccountIdentifier: null,
};

test("summarizeOrder: describes an offramp order in plain English", () => {
  assert.match(summarizeOrder(COMPLETED_OFFRAMP), /500 USDC from base to GTBNGPC account 0123456789/);
});

test("summarizeOrder: describes an onramp order including the refund bank", () => {
  assert.match(summarizeOrder(COMPLETED_ONRAMP), /50000 NGN with refund bank OPAYNGPC/);
});

test("mergeRepeat: an exact 'do that again' fills every field from the completed offramp order", () => {
  const merged = mergeRepeat(EMPTY_EXTRACTION, COMPLETED_OFFRAMP);
  assert.equal(merged.direction, "offramp");
  assert.equal(merged.amount, "500");
  assert.equal(merged.token, "USDC");
  assert.equal(merged.sourceChain, "base");
  assert.equal(merged.destinationCurrency, "NGN");
  assert.equal(merged.institutionName, "GTBNGPC");
  assert.equal(merged.accountIdentifier, "0123456789");
});

test("mergeRepeat: 'same but 200 this time' keeps the stated override and backfills the rest", () => {
  const merged = mergeRepeat({ ...EMPTY_EXTRACTION, amount: "200" }, COMPLETED_OFFRAMP);
  assert.equal(merged.amount, "200");
  assert.equal(merged.institutionName, "GTBNGPC");
  assert.equal(merged.accountIdentifier, "0123456789");
});

test("mergeRepeat: 'repeat but to my UBA account' overrides only the bank", () => {
  const merged = mergeRepeat({ ...EMPTY_EXTRACTION, institutionName: "UBA" }, COMPLETED_OFFRAMP);
  assert.equal(merged.institutionName, "UBA");
  assert.equal(merged.amount, "500");
  assert.equal(merged.accountIdentifier, "0123456789");
});

test("mergeRepeat: fills every field from a completed onramp order", () => {
  const merged = mergeRepeat(EMPTY_EXTRACTION, COMPLETED_ONRAMP);
  assert.equal(merged.direction, "onramp");
  assert.equal(merged.fiatAmount, "50000");
  assert.equal(merged.fiatCurrency, "NGN");
  assert.equal(merged.destinationStellarAddress, COMPLETED_ONRAMP.destinationAddress);
  assert.equal(merged.refundInstitutionName, "OPAYNGPC");
  assert.equal(merged.refundAccountIdentifier, "0987654321");
});
