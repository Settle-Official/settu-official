import test from "node:test";
import assert from "node:assert/strict";
import { resolveInstitutionAlias } from "./institution-aliases";

test("resolveInstitutionAlias: known nicknames resolve regardless of case/spacing/punctuation", () => {
  assert.equal(resolveInstitutionAlias("GTBank"), "guaranty trust");
  assert.equal(resolveInstitutionAlias("gt-bank"), "guaranty trust");
  assert.equal(resolveInstitutionAlias("GTB"), "guaranty trust");
  assert.equal(resolveInstitutionAlias("UBA"), "united bank");
  assert.equal(resolveInstitutionAlias("9PSB"), "9 payment service");
  assert.equal(resolveInstitutionAlias("FirstBank"), "first bank");
});

test("resolveInstitutionAlias: an unknown name returns null, not a guess", () => {
  assert.equal(resolveInstitutionAlias("SomeRandomBank"), null);
  assert.equal(resolveInstitutionAlias(""), null);
});
