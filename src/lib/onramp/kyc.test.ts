import test from "node:test";
import assert from "node:assert/strict";
import { buildOnrampKyc, paycrestValidationDetail } from "./kyc";

// A fixed "today" so age checks don't drift.
const TODAY = new Date("2026-10-13T12:00:00Z");
const NAME = "UCHE MACNELSON OFATU";

const ok = (input: unknown) => {
  const result = buildOnrampKyc(input, NAME, TODAY);
  if (!result.ok) assert.fail(result.error);
  return result.kyc;
};
const err = (input: unknown) => {
  const result = buildOnrampKyc(input, NAME, TODAY);
  if (result.ok) assert.fail("expected a validation error");
  return result.error;
};

test("a NIN alone covers both the ID document and the Nigerian identifier", () => {
  assert.deepEqual(ok({ birthDate: "1995-04-12", idType: "nin", idNumber: "12345678901" }), {
    entityType: "person",
    personDetails: {
      fullName: NAME,
      birthDate: "1995-04-12",
      idDocument: { type: "nationalID", number: "12345678901", issuerCountry: "NG" },
    },
  });
});

test("a passport needs a BVN alongside it, sent as the tax id", () => {
  assert.deepEqual(
    ok({ birthDate: "1995-04-12", idType: "passport", idNumber: "a12345678", bvn: "22212345678" }),
    {
      entityType: "person",
      personDetails: {
        fullName: NAME,
        birthDate: "1995-04-12",
        idDocument: { type: "passport", number: "A12345678", issuerCountry: "NG" },
        taxId: { type: "BVN", value: "22212345678", country: "NG" },
      },
    },
  );
  assert.match(err({ birthDate: "1995-04-12", idType: "passport", idNumber: "A12345678" }), /BVN/);
});

test("a driver's licence is accepted with a BVN", () => {
  const kyc = ok({
    birthDate: "1995-04-12",
    idType: "driverLicense",
    idNumber: " abc-123456789 ",
    bvn: "22212345678",
  });
  assert.equal(kyc.personDetails.idDocument.type, "driverLicense");
  assert.equal(kyc.personDetails.idDocument.number, "ABC-123456789");
});

test("spaces typed into a NIN or BVN are ignored", () => {
  assert.equal(
    ok({ birthDate: "1995-04-12", idType: "nin", idNumber: "1234 5678 901" }).personDetails
      .idDocument.number,
    "12345678901",
  );
});

test("rejects a NIN or BVN that isn't 11 digits", () => {
  assert.match(err({ birthDate: "1995-04-12", idType: "nin", idNumber: "1234567890" }), /NIN/);
  assert.match(err({ birthDate: "1995-04-12", idType: "nin", idNumber: "1234567890a" }), /NIN/);
  assert.match(
    err({ birthDate: "1995-04-12", idType: "passport", idNumber: "A12345678", bvn: "123" }),
    /BVN/,
  );
});

test("rejects anyone under 18, to the day", () => {
  // Turns 18 tomorrow.
  assert.match(err({ birthDate: "2008-10-14", idType: "nin", idNumber: "12345678901" }), /18/);
  // Turns 18 today.
  ok({ birthDate: "2008-10-13", idType: "nin", idNumber: "12345678901" });
});

test("rejects dates that aren't real, or aren't plausible", () => {
  for (const birthDate of ["", "12/04/1995", "1995-13-01", "1995-02-30", "1890-01-01", "2030-01-01"]) {
    assert.match(
      err({ birthDate, idType: "nin", idNumber: "12345678901" }),
      /date of birth|18/i,
      birthDate,
    );
  }
});

test("rejects an unknown ID type, a missing ID number, and a missing name", () => {
  assert.match(err({ birthDate: "1995-04-12", idType: "voterCard", idNumber: "123" }), /ID/);
  assert.match(err({ birthDate: "1995-04-12", idType: "passport", idNumber: " ", bvn: "22212345678" }), /number/i);
  assert.match(err(null), /identity/i);
  const noName = buildOnrampKyc(
    { birthDate: "1995-04-12", idType: "nin", idNumber: "12345678901" },
    "  ",
    TODAY,
  );
  assert.equal(noName.ok, false);
});

test("Paycrest's field-level reason is pulled out of a validation error", () => {
  assert.equal(
    paycrestValidationDetail({
      status: "error",
      message: "Failed to validate payload",
      data: { field: "Source", message: "kyc.personDetails.birthDate is required" },
    }),
    "kyc.personDetails.birthDate is required",
  );
  assert.equal(
    paycrestValidationDetail({
      message: "Failed to validate payload",
      data: [
        { field: "Source", message: "refund account name does not match" },
        { field: "Amount", message: "too small" },
      ],
    }),
    "refund account name does not match; too small",
  );
  assert.equal(paycrestValidationDetail({ message: "Failed to validate payload" }), null);
  assert.equal(paycrestValidationDetail(null), null);
});
