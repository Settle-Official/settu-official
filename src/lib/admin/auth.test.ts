import test from "node:test";
import assert from "node:assert/strict";

import { ADMIN_COOKIE, isAuthorisedAdmin, passwordToCookie } from "./auth.ts";

// Just the two things isAuthorisedAdmin reads off a NextRequest.
function req({ auth, cookie }: { auth?: string; cookie?: string } = {}) {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? auth ?? null : null) },
    cookies: { get: (k: string) => (k === ADMIN_COOKIE && cookie ? { value: cookie } : undefined) },
  } as unknown as Parameters<typeof isAuthorisedAdmin>[0];
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const SECRET = "s".repeat(64);

test("with no secret configured, every request is refused — even one presenting a token", () => {
  // The production bug: the variable was unset, and "unset" meant "allow".
  withEnv({ ADMIN_API_SECRET: undefined }, () => {
    assert.equal(isAuthorisedAdmin(req()), false);
    assert.equal(isAuthorisedAdmin(req({ auth: "Bearer anything" })), false);
    assert.equal(isAuthorisedAdmin(req({ auth: "Bearer " })), false);
  });
});

test("the right bearer token is accepted", () => {
  withEnv({ ADMIN_API_SECRET: SECRET }, () => {
    assert.equal(isAuthorisedAdmin(req({ auth: `Bearer ${SECRET}` })), true);
  });
});

test("a wrong, empty or missing token is refused", () => {
  withEnv({ ADMIN_API_SECRET: SECRET }, () => {
    assert.equal(isAuthorisedAdmin(req({ auth: "Bearer nope" })), false);
    assert.equal(isAuthorisedAdmin(req({ auth: "Bearer " })), false);
    assert.equal(isAuthorisedAdmin(req({ auth: SECRET })), false); // no "Bearer " prefix
    assert.equal(isAuthorisedAdmin(req()), false);
  });
});

test("a console session cookie is accepted, and a forged one is not", () => {
  withEnv({ ADMIN_API_SECRET: SECRET, ADMIN_DASHBOARD_PASSWORD: "correct horse" }, () => {
    const cookie = passwordToCookie("correct horse");
    assert.ok(cookie);
    assert.equal(isAuthorisedAdmin(req({ cookie })), true);
    const [expiry] = cookie.split(".");
    assert.equal(isAuthorisedAdmin(req({ cookie: `${expiry}.${"0".repeat(64)}` })), false);
    assert.equal(passwordToCookie("wrong"), null);
  });
});

test("a session cookie stops working once the secret is removed", () => {
  let cookie: string | null = null;
  withEnv({ ADMIN_API_SECRET: SECRET, ADMIN_DASHBOARD_PASSWORD: "pw" }, () => {
    cookie = passwordToCookie("pw");
  });
  withEnv({ ADMIN_API_SECRET: undefined }, () => {
    assert.equal(isAuthorisedAdmin(req({ cookie: cookie! })), false);
  });
});
