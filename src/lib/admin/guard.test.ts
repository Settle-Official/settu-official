import test from "node:test";
import assert from "node:assert/strict";
import { callerCredential } from "./guard";

test("reads a bearer token", () => {
  const headers = new Headers({ authorization: "Bearer abc123" });
  assert.equal(callerCredential(headers), "abc123");
});

test("falls back to the session cookie", () => {
  const headers = new Headers({ cookie: "other=1; settu_session=tok; x=2" });
  assert.equal(callerCredential(headers), "tok");
});

test("the cookie name must match exactly", () => {
  // A prefix match would let `x_settu_session` impersonate the real cookie --
  // the same case the Rust extractor guards against.
  const headers = new Headers({ cookie: "x_settu_session=evil" });
  assert.equal(callerCredential(headers), null);
});

test("a bearer token wins over a cookie", () => {
  const headers = new Headers({
    authorization: "Bearer from-header",
    cookie: "settu_session=from-cookie",
  });
  assert.equal(callerCredential(headers), "from-header");
});

test("no credential at all returns null, so the guard fails closed", () => {
  assert.equal(callerCredential(new Headers()), null);
  assert.equal(callerCredential(new Headers({ authorization: "Bearer " })), null);
  assert.equal(callerCredential(new Headers({ cookie: "settu_session=" })), null);
  assert.equal(callerCredential(new Headers({ cookie: "unrelated=1" })), null);
});
