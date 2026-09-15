# Onramp Agent Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Settu's Agent Mode chat handle onramp (fiat → USDC) requests in natural language, alongside the offramp support it already has.

**Architecture:** Extend the existing `/api/offramp/agent/parse` route's extraction schema with a `direction` field, add a new `agent-onramp-resolver.ts` mirroring the existing `agent-resolver.ts` (reusing its exported `matchInstitution` for refund-bank nickname resolution), and add two new message types to `AgentPanel.tsx` — an onramp confirmation card and a post-confirm virtual-account card — with SSE-driven chat narration reusing `OnrampPanel.tsx`'s existing status copy.

**Tech Stack:** Next.js App Router, TypeScript, Zod, Vercel AI SDK (`generateObject` against Google Gemini, already wired), `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-15-onramp-agent-mode-design.md`

## Global Constraints

- No wallet connection required for onramp in Agent Mode — the destination Stellar address is always asked for explicitly in the conversation, never defaulted from a connected wallet.
- The refund bank account is required upfront, resolved with the same rigor as offramp's beneficiary (bank matched via `matchInstitution`, account verified via `verifyAccount`).
- Onramp confirmation happens before order creation, even though nothing irreversible happens until the user pays.
- Intent (onramp vs offramp) is auto-detected from the message — the user never has to say a direction keyword.
- Status narration text must match `OnrampPanel.tsx`'s existing `STATUS_LABEL` copy exactly — no new/invented wording for status transitions already covered there.
- All new pure logic (resolver, step-bridge) must be unit-testable via `node --test` with mocked `fetch`, following the exact pattern in `src/lib/offramp/agent-resolver.test.ts`.

---

### Task 1: Export `matchInstitution` from `agent-resolver.ts`

**Files:**
- Modify: `src/lib/offramp/agent-resolver.ts:101`

**Interfaces:**
- Produces: `export function matchInstitution(institutions: { code: string; name: string }[], freeText: string): { code: string } | "none" | "ambiguous"` — used by Task 4's onramp resolver.

- [ ] **Step 1: Export the function**

In `src/lib/offramp/agent-resolver.ts`, change:

```ts
function matchInstitution(
```

to:

```ts
export function matchInstitution(
```

This is the only change — the function's internals (direct match, then alias fallback via `resolveInstitutionAlias`) are unchanged.

- [ ] **Step 2: Run the existing test suite to confirm nothing broke**

Run: `npm test`
Expected: all existing tests still pass (this is a pure visibility change — `resolveAgentOrder`'s behavior, and the tests covering it, are untouched).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/offramp/agent-resolver.ts
git commit -m "refactor(offramp): export matchInstitution for reuse by the onramp agent resolver"
```

---

### Task 2: Extract shared onramp status-label copy

**Files:**
- Create: `src/lib/onramp/status-labels.ts`
- Modify: `src/components/OnrampPanel.tsx` (remove the local `STATUS_LABEL` map, import the shared one)

**Interfaces:**
- Produces: `export const ONRAMP_STATUS_LABEL: Record<string, string>` — used by `OnrampPanel.tsx` (Task 2) and `agent-onramp-step-bridge.ts` (Task 5).

- [ ] **Step 1: Create the shared status-label file**

```ts
// src/lib/onramp/status-labels.ts

/**
 * User-facing copy for each onramp status, shared between OnrampPanel's own
 * status display and Agent Mode's chat narration — one source of truth so
 * the two surfaces never drift apart in wording.
 */
export const ONRAMP_STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for your bank transfer…",
  deposited: "Fiat received — confirming…",
  validated: "Payment confirmed by provider…",
  settling: "Releasing USDC on Base…",
  settled: "USDC received — bridging to Stellar…",
  bridging: "Bridging to your Stellar wallet…",
  delivered: "Delivered to your Stellar wallet ✓",
  bridge_failed: "Delivery held for review — our team was alerted.",
  refunding: "Refund in progress…",
  refunded: "Order refunded.",
  expired: "Order expired — no deposit received in time.",
  unknown: "Processing…",
};
```

- [ ] **Step 2: Update `OnrampPanel.tsx` to use the shared map**

In `src/components/OnrampPanel.tsx`, find:

```ts
const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for your bank transfer…",
  deposited: "Fiat received — confirming…",
  validated: "Payment confirmed by provider…",
  settling: "Releasing USDC on Base…",
  settled: "USDC received — bridging to Stellar…",
  bridging: "Bridging to your Stellar wallet…",
  delivered: "Delivered to your Stellar wallet ✓",
  bridge_failed: "Delivery held for review — our team was alerted.",
  refunding: "Refund in progress…",
  refunded: "Order refunded.",
  expired: "Order expired — no deposit received in time.",
  unknown: "Processing…",
};
```

Delete it, and add this import near the top of the file (alongside the existing `SelectField` import):

```ts
import { ONRAMP_STATUS_LABEL } from "@/lib/onramp/status-labels";
```

Then find the one usage:

```ts
{STATUS_LABEL[status] ?? STATUS_LABEL.pending}
```

and change it to:

```ts
{ONRAMP_STATUS_LABEL[status] ?? ONRAMP_STATUS_LABEL.pending}
```

- [ ] **Step 3: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors. This is a pure refactor — no behavior change.

- [ ] **Step 4: Commit**

```bash
git add src/lib/onramp/status-labels.ts src/components/OnrampPanel.tsx
git commit -m "refactor(onramp): extract shared status-label copy for reuse by Agent Mode"
```

---

### Task 3: Extract shared client-side onramp order creation

**Files:**
- Create: `src/lib/onramp/client.ts`
- Modify: `src/components/OnrampPanel.tsx` (replace the inline fetch in `handleSubmit` with the shared helper; remove its now-duplicate local `ProviderAccount` interface)

**Interfaces:**
- Consumes: `OnrampProviderAccount` from `src/lib/offramp/types` (already exists — see Task Notes below).
- Produces:
  ```ts
  export interface CreateOnrampOrderInput {
    fiatAmount: string;
    currency: string;
    userStellarAddress: string;
    refundAccount: { institution: string; accountIdentifier: string; accountName: string };
  }
  export interface CreateOnrampOrderResult {
    id: string;
    status: string;
    providerAccount: OnrampProviderAccount;
  }
  export async function createOnrampOrder(input: CreateOnrampOrderInput): Promise<CreateOnrampOrderResult>
  ```
  Used by `OnrampPanel.tsx` (this task) and `AgentPanel.tsx` (Task 6).

**Task Notes:** `src/lib/offramp/types/index.ts` already exports `OnrampProviderAccount { institution, accountIdentifier, accountName, amountToTransfer, currency, validUntil }` — identical in shape to `OnrampPanel.tsx`'s current local `ProviderAccount` interface. This task consolidates onto the shared one.

- [ ] **Step 1: Create the shared client helper**

```ts
// src/lib/onramp/client.ts

import type { OnrampProviderAccount } from "@/lib/offramp/types";

export interface CreateOnrampOrderInput {
  fiatAmount: string;
  currency: string;
  userStellarAddress: string;
  refundAccount: {
    institution: string;
    accountIdentifier: string;
    accountName: string;
  };
}

export interface CreateOnrampOrderResult {
  id: string;
  status: string;
  providerAccount: OnrampProviderAccount;
}

/**
 * Creates an onramp order via the server route. Thrown errors carry the
 * server's own message (validation failure, or a friendly upstream-outage
 * message for a Paycrest 5xx) — callers show it directly, same contract
 * OnrampPanel's try/catch already assumed before this was extracted.
 */
export async function createOnrampOrder(
  input: CreateOnrampOrderInput,
): Promise<CreateOnrampOrderResult> {
  const res = await fetch("/api/onramp/order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload?.error || "Failed to create onramp order");
  }
  return payload.data as CreateOnrampOrderResult;
}
```

- [ ] **Step 2: Update `OnrampPanel.tsx` to use it**

In `src/components/OnrampPanel.tsx`, delete the local interface:

```ts
interface ProviderAccount {
  institution: string;
  accountIdentifier: string;
  accountName: string;
  amountToTransfer: string;
  currency: string;
  validUntil: string;
}
```

Add these imports near the top of the file:

```ts
import { createOnrampOrder } from "@/lib/onramp/client";
import type { OnrampProviderAccount } from "@/lib/offramp/types";
```

Find the `providerAccount` state declaration:

```ts
const [providerAccount, setProviderAccount] =
  useState<ProviderAccount | null>(null);
```

and change the type to:

```ts
const [providerAccount, setProviderAccount] =
  useState<OnrampProviderAccount | null>(null);
```

Then find `handleSubmit`:

```ts
const handleSubmit = async () => {
  if (!isConnected) {
    onConnect();
    return;
  }
  if (!canSubmit || !destinationAddress) return;

  setIsSubmitting(true);
  setError(null);
  try {
    const res = await fetch("/api/onramp/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fiatAmount: amount,
        currency,
        userStellarAddress: destinationAddress,
        refundAccount: {
          institution: bank,
          accountIdentifier: accountNumber,
          accountName,
        },
      }),
    });
    const payload = await res.json();
    if (!res.ok) {
      throw new Error(payload?.error || "Failed to create onramp order");
    }
    setOrderId(payload.data.id);
    setProviderAccount(payload.data.providerAccount);
    setStatus(payload.data.status || "pending");
    setPhase("awaiting-deposit");
  } catch (e: any) {
    setError(e?.message || "Something went wrong");
    setPhase("error");
  } finally {
    setIsSubmitting(false);
  }
};
```

and replace the body of the `try` block with:

```ts
const handleSubmit = async () => {
  if (!isConnected) {
    onConnect();
    return;
  }
  if (!canSubmit || !destinationAddress) return;

  setIsSubmitting(true);
  setError(null);
  try {
    const result = await createOnrampOrder({
      fiatAmount: amount,
      currency,
      userStellarAddress: destinationAddress,
      refundAccount: {
        institution: bank,
        accountIdentifier: accountNumber,
        accountName,
      },
    });
    setOrderId(result.id);
    setProviderAccount(result.providerAccount);
    setStatus(result.status || "pending");
    setPhase("awaiting-deposit");
  } catch (e: any) {
    setError(e?.message || "Something went wrong");
    setPhase("error");
  } finally {
    setIsSubmitting(false);
  }
};
```

- [ ] **Step 3: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Manually verify OnrampPanel still works**

Run: `npm run dev`, open the app, switch to the On-ramp tab, and confirm the form still renders and (if you have a Paycrest sandbox key configured) that submitting still reaches the "awaiting deposit" screen. This is a pure refactor — if anything looks different, stop and re-check the diff before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/onramp/client.ts src/components/OnrampPanel.tsx
git commit -m "refactor(onramp): extract shared client-side order creation for reuse by Agent Mode"
```

---

### Task 4: `agent-onramp-resolver.ts` — extraction, classification, resolution

**Files:**
- Create: `src/lib/offramp/agent-onramp-resolver.ts`
- Test: `src/lib/offramp/agent-onramp-resolver.test.ts`

**Interfaces:**
- Consumes: `fetchCurrencies`, `fetchInstitutions`, `verifyAccount` from `./paycrest-directory`; `validateAmount`, `validateAddress` from `./utils/validation`; `matchInstitution` from `./agent-resolver` (Task 1).
- Produces:
  ```ts
  export interface OnrampAgentExtraction {
    fiatAmount: string | null;
    fiatCurrency: string | null;
    destinationStellarAddress: string | null;
    refundInstitutionName: string | null;
    refundAccountIdentifier: string | null;
  }
  export interface ResolvedOnrampOrder {
    fiatAmount: string;
    currency: string;
    destinationAddress: string;
    refundAccount: { institution: string; accountIdentifier: string; accountName: string; currency: string };
  }
  export type OnrampResolveResult =
    | { status: "resolved"; order: ResolvedOnrampOrder }
    | { status: "clarify"; message: string }
    | { status: "recap"; missing: string[] };
  export function classifyOnrampExtraction(extraction: OnrampAgentExtraction): { status: "complete" } | { status: "clarify"; message: string } | { status: "recap"; missing: string[] }
  export async function resolveOnrampOrder(extraction: OnrampAgentExtraction): Promise<OnrampResolveResult>
  ```
  Used by the parse route (Task 6).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/offramp/agent-onramp-resolver.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyOnrampExtraction,
  resolveOnrampOrder,
  type OnrampAgentExtraction,
} from "./agent-onramp-resolver";

const COMPLETE: OnrampAgentExtraction = {
  fiatAmount: "100000",
  fiatCurrency: "NGN",
  destinationStellarAddress:
    "GALC4XJL55YPA7WLS3VDK3IOZDQ4LF5ZXO422EJZ34MPFI44NPXZOQCR",
  refundInstitutionName: "OPay",
  refundAccountIdentifier: "0987654321",
};

test("classifyOnrampExtraction: fully populated is complete", () => {
  assert.equal(classifyOnrampExtraction(COMPLETE).status, "complete");
});

test("classifyOnrampExtraction: one missing field asks a targeted question, not a recap", () => {
  const result = classifyOnrampExtraction({
    ...COMPLETE,
    refundAccountIdentifier: null,
  });
  assert.equal(result.status, "clarify");
  if (result.status === "clarify") {
    assert.match(result.message, /account number/i);
  }
});

test("classifyOnrampExtraction: three or more missing fields is a recap, not a question", () => {
  const result = classifyOnrampExtraction({
    ...COMPLETE,
    refundAccountIdentifier: null,
    fiatAmount: null,
    destinationStellarAddress: null,
  });
  assert.equal(result.status, "recap");
  if (result.status === "recap") {
    assert.equal(result.missing.length, 3);
  }
});

function withFetch(
  impl: typeof globalThis.fetch,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

test("resolveOnrampOrder: happy path resolves with the verified name and real institution code", async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/currencies")) {
        return jsonResponse({
          data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }],
        });
      }
      if (u.includes("/institutions/")) {
        return jsonResponse({ data: [{ code: "OPAYNGPC", name: "OPay" }] });
      }
      if (u.includes("/verify-account")) {
        return jsonResponse({ data: { accountName: "JOHN DOE" } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
    async () => {
      const result = await resolveOnrampOrder(COMPLETE);
      assert.equal(result.status, "resolved");
      if (result.status === "resolved") {
        assert.equal(result.order.fiatAmount, "100000");
        assert.equal(result.order.currency, "NGN");
        assert.equal(
          result.order.destinationAddress,
          "GALC4XJL55YPA7WLS3VDK3IOZDQ4LF5ZXO422EJZ34MPFI44NPXZOQCR",
        );
        assert.equal(result.order.refundAccount.institution, "OPAYNGPC");
        assert.equal(result.order.refundAccount.accountName, "JOHN DOE");
      }
    },
  );
});

test("resolveOnrampOrder: a bank nickname alias (GTBank) still resolves", async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/currencies")) {
        return jsonResponse({
          data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }],
        });
      }
      if (u.includes("/institutions/")) {
        return jsonResponse({
          data: [{ code: "GTBINGLA", name: "Guaranty Trust Bank" }],
        });
      }
      if (u.includes("/verify-account")) {
        return jsonResponse({ data: { accountName: "JANE DOE" } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
    async () => {
      const result = await resolveOnrampOrder({
        ...COMPLETE,
        refundInstitutionName: "GTBank",
      });
      assert.equal(result.status, "resolved");
      if (result.status === "resolved") {
        assert.equal(result.order.refundAccount.institution, "GTBINGLA");
      }
    },
  );
});

test("resolveOnrampOrder: an invalid Stellar address asks for a valid one", async () => {
  const result = await resolveOnrampOrder({
    ...COMPLETE,
    destinationStellarAddress: "not-a-real-address",
  });
  assert.equal(result.status, "clarify");
  if (result.status === "clarify") {
    assert.match(result.message, /stellar address/i);
  }
});

test("resolveOnrampOrder: unsupported currency asks for a different one", async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/currencies")) {
        return jsonResponse({
          data: [{ code: "KES", name: "Kenyan Shilling", symbol: "KSh" }],
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
    async () => {
      const result = await resolveOnrampOrder(COMPLETE);
      assert.equal(result.status, "clarify");
      if (result.status === "clarify") {
        assert.match(result.message, /NGN|currency|support/i);
      }
    },
  );
});

test("resolveOnrampOrder: unresolvable refund bank asks which bank, not a guess", async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/currencies")) {
        return jsonResponse({
          data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }],
        });
      }
      if (u.includes("/institutions/")) {
        return jsonResponse({ data: [{ code: "OPAYNGPC", name: "OPay" }] });
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
    async () => {
      const result = await resolveOnrampOrder({
        ...COMPLETE,
        refundInstitutionName: "SomeBankThatDoesNotExist",
      });
      assert.equal(result.status, "clarify");
      if (result.status === "clarify") assert.match(result.message, /bank/i);
    },
  );
});

test("resolveOnrampOrder: failed refund-account verification asks to double check the number", async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/currencies")) {
        return jsonResponse({
          data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }],
        });
      }
      if (u.includes("/institutions/")) {
        return jsonResponse({ data: [{ code: "OPAYNGPC", name: "OPay" }] });
      }
      if (u.includes("/verify-account")) return jsonResponse({}, false);
      throw new Error(`unexpected fetch: ${u}`);
    },
    async () => {
      const result = await resolveOnrampOrder(COMPLETE);
      assert.equal(result.status, "clarify");
      if (result.status === "clarify") {
        assert.match(result.message, /account number/i);
      }
    },
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/agent-onramp-resolver.test.ts`
Expected: FAIL — `Cannot find module './agent-onramp-resolver'` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/offramp/agent-onramp-resolver.ts

import { fetchCurrencies, fetchInstitutions, verifyAccount } from "./paycrest-directory";
import { matchInstitution } from "./agent-resolver";
import { validateAmount, validateAddress } from "./utils/validation";

export interface OnrampAgentExtraction {
  fiatAmount: string | null;
  fiatCurrency: string | null;
  destinationStellarAddress: string | null;
  refundInstitutionName: string | null;
  refundAccountIdentifier: string | null;
}

export interface ResolvedOnrampOrder {
  fiatAmount: string;
  currency: string;
  destinationAddress: string;
  refundAccount: {
    institution: string;
    accountIdentifier: string;
    accountName: string;
    currency: string;
  };
}

export type OnrampResolveResult =
  | { status: "resolved"; order: ResolvedOnrampOrder }
  | { status: "clarify"; message: string }
  | { status: "recap"; missing: string[] };

const FIELD_LABELS: Record<keyof OnrampAgentExtraction, string> = {
  fiatAmount: "the amount",
  fiatCurrency: "which currency you're paying in",
  destinationStellarAddress: "the Stellar address to receive your USDC",
  refundInstitutionName: "your refund bank",
  refundAccountIdentifier: "your refund account number",
};

function missingFields(
  extraction: OnrampAgentExtraction,
): (keyof OnrampAgentExtraction)[] {
  return (Object.keys(FIELD_LABELS) as (keyof OnrampAgentExtraction)[]).filter(
    (key) => !extraction[key],
  );
}

/**
 * Same ask-vs-recap threshold as offramp's classifyExtraction, for the same
 * reason: 1-2 missing fields gets one targeted question, 3+ gets a single
 * recap rather than an interrogation one field at a time.
 */
export function classifyOnrampExtraction(
  extraction: OnrampAgentExtraction,
): { status: "complete" } | { status: "clarify"; message: string } | { status: "recap"; missing: string[] } {
  const missing = missingFields(extraction);
  if (missing.length === 0) return { status: "complete" };
  if (missing.length <= 2) {
    const labels = missing.map((key) => FIELD_LABELS[key]);
    return { status: "clarify", message: `What's ${labels.join(" and ")}?` };
  }
  return { status: "recap", missing: missing.map((key) => FIELD_LABELS[key]) };
}

export async function resolveOnrampOrder(
  extraction: OnrampAgentExtraction,
): Promise<OnrampResolveResult> {
  const classified = classifyOnrampExtraction(extraction);
  if (classified.status !== "complete") return classified;

  // All five fields are non-null past this point (classifyOnrampExtraction gated it).
  const fiatAmount = extraction.fiatAmount!;
  const destinationAddress = extraction.destinationStellarAddress!;
  const currencyRaw = extraction.fiatCurrency!.toUpperCase();
  const refundInstitutionName = extraction.refundInstitutionName!;
  const refundAccountIdentifier = extraction.refundAccountIdentifier!;

  if (!validateAmount(fiatAmount)) {
    return { status: "clarify", message: "What amount would you like to onramp?" };
  }

  if (!validateAddress(destinationAddress, "stellar")) {
    return {
      status: "clarify",
      message: "That doesn't look like a valid Stellar address — it should start with G and be 56 characters. What's the right one?",
    };
  }

  const currencies = await fetchCurrencies();
  const currencyMatch = currencies.find((c) => c.code.toUpperCase() === currencyRaw);
  if (!currencyMatch) {
    const supported = currencies.map((c) => c.code).join(", ") || "a supported currency";
    return {
      status: "clarify",
      message: `I can only take payment in ${supported} right now — which currency did you mean?`,
    };
  }

  const institutions = await fetchInstitutions(currencyMatch.code);
  const institutionMatch = matchInstitution(institutions, refundInstitutionName);
  if (institutionMatch === "none") {
    return {
      status: "clarify",
      message: `I couldn't find "${refundInstitutionName}" as a ${currencyMatch.code} bank — which bank should I use for refunds?`,
    };
  }
  if (institutionMatch === "ambiguous") {
    return {
      status: "clarify",
      message: `A few banks match "${refundInstitutionName}" — can you give the exact bank name for your refund account?`,
    };
  }

  const accountName = await verifyAccount(institutionMatch.code, refundAccountIdentifier);
  if (!accountName) {
    return {
      status: "clarify",
      message: `I couldn't verify a ${refundInstitutionName} account at ${refundAccountIdentifier} — please double check the refund account number.`,
    };
  }

  return {
    status: "resolved",
    order: {
      fiatAmount,
      currency: currencyMatch.code,
      destinationAddress,
      refundAccount: {
        institution: institutionMatch.code,
        accountIdentifier: refundAccountIdentifier,
        accountName,
        currency: currencyMatch.code,
      },
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/agent-onramp-resolver.test.ts`
Expected: PASS, all 9 tests.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npx tsc --noEmit && npm test`
Expected: no errors; full suite (existing + 9 new) passes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/offramp/agent-onramp-resolver.ts src/lib/offramp/agent-onramp-resolver.test.ts
git commit -m "feat(onramp): agent resolver for fiat-to-crypto orders, reusing offramp's bank matching"
```

---

### Task 5: `agent-onramp-step-bridge.ts` — SSE status to chat event mapping

**Files:**
- Create: `src/lib/offramp/agent-onramp-step-bridge.ts`
- Test: `src/lib/offramp/agent-onramp-step-bridge.test.ts`

**Interfaces:**
- Consumes: `ONRAMP_STATUS_LABEL` from `@/lib/onramp/status-labels` (Task 2).
- Produces:
  ```ts
  export interface OnrampStepEvent { id: string; kind: "progress" | "success" | "error"; text: string; }
  export function onrampStatusToAgentEvent(status: string, opts: { stellarTxHash?: string }): OnrampStepEvent | null
  ```
  Used by `AgentPanel.tsx` (Task 6).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/offramp/agent-onramp-step-bridge.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { onrampStatusToAgentEvent } from "./agent-onramp-step-bridge";

test("pending maps to a progress event with the standard copy", () => {
  const event = onrampStatusToAgentEvent("pending", {});
  assert.ok(event);
  assert.equal(event!.kind, "progress");
  assert.equal(event!.text, "Waiting for your bank transfer…");
});

test("delivered maps to a success event and includes a shortened tx hash", () => {
  const event = onrampStatusToAgentEvent("delivered", {
    stellarTxHash: "abcdef1234567890abcdef1234567890",
  });
  assert.ok(event);
  assert.equal(event!.kind, "success");
  assert.match(event!.text, /abcdef12/);
});

test("delivered with no tx hash still returns a success event", () => {
  const event = onrampStatusToAgentEvent("delivered", {});
  assert.ok(event);
  assert.equal(event!.kind, "success");
});

test("bridge_failed maps to an error event", () => {
  const event = onrampStatusToAgentEvent("bridge_failed", {});
  assert.ok(event);
  assert.equal(event!.kind, "error");
});

test("refunded and expired map to error events with their own copy", () => {
  const refunded = onrampStatusToAgentEvent("refunded", {});
  const expired = onrampStatusToAgentEvent("expired", {});
  assert.ok(refunded);
  assert.ok(expired);
  assert.equal(refunded!.kind, "error");
  assert.equal(expired!.kind, "error");
  assert.notEqual(refunded!.text, expired!.text);
});

test("an unrecognized status returns null rather than a made-up message", () => {
  assert.equal(onrampStatusToAgentEvent("some-future-status", {}), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/agent-onramp-step-bridge.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/offramp/agent-onramp-step-bridge.ts

import { ONRAMP_STATUS_LABEL } from "@/lib/onramp/status-labels";

export interface OnrampStepEvent {
  id: string;
  kind: "progress" | "success" | "error";
  text: string;
}

const ERROR_STATUSES = new Set(["bridge_failed", "refunding", "refunded", "expired"]);

/**
 * Maps an onramp order's status (from the /api/onramp/stream SSE payload) to
 * a chat message, reusing OnrampPanel's own ONRAMP_STATUS_LABEL copy so the
 * two surfaces never say different things for the same status. Pure and
 * synchronous — no network access — so it's fully unit-testable.
 */
export function onrampStatusToAgentEvent(
  status: string,
  opts: { stellarTxHash?: string },
): OnrampStepEvent | null {
  const label = ONRAMP_STATUS_LABEL[status];
  if (!label) return null;

  if (status === "delivered") {
    const shortHash = opts.stellarTxHash ? opts.stellarTxHash.slice(0, 8) : null;
    return {
      id: status,
      kind: "success",
      text: shortHash ? `✅ ${label} (tx ${shortHash}…)` : `✅ ${label}`,
    };
  }

  return {
    id: status,
    kind: ERROR_STATUSES.has(status) ? "error" : "progress",
    text: label,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/agent-onramp-step-bridge.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/offramp/agent-onramp-step-bridge.ts src/lib/offramp/agent-onramp-step-bridge.test.ts
git commit -m "feat(onramp): map onramp order status to Agent Mode chat narration"
```

---

### Task 6: Unify the parse route with direction detection

**Files:**
- Modify: `src/app/api/offramp/agent/parse/route.ts`

**Interfaces:**
- Consumes: `classifyOnrampExtraction`, `resolveOnrampOrder`, `type OnrampAgentExtraction` from `@/lib/offramp/agent-onramp-resolver` (Task 4).
- Produces: the route's JSON response gains a new `kind: "resolved-onramp"` variant: `{ kind: "resolved-onramp"; order: ResolvedOnrampOrder }`. Used by `AgentPanel.tsx` (Task 7).

- [ ] **Step 1: Update the imports and schema**

In `src/app/api/offramp/agent/parse/route.ts`, add this import alongside the existing `agent-resolver` one:

```ts
import {
  classifyOnrampExtraction,
  resolveOnrampOrder,
  type OnrampAgentExtraction,
} from "@/lib/offramp/agent-onramp-resolver";
```

Replace the `extractionSchema` definition with:

```ts
const extractionSchema = z.object({
  direction: z.enum(["onramp", "offramp"]).nullable().describe(
    "Whether the user wants to convert fiat to crypto (onramp — they're paying money to receive USDC) or crypto to fiat (offramp — they're sending USDC to receive money in their bank). Null if genuinely ambiguous.",
  ),
  // Offramp fields.
  amount: z.string().nullable().describe("The numeric USDC amount, as a plain string, e.g. \"1000\". Null if not stated. Offramp only."),
  token: z.string().nullable().describe("The token symbol, e.g. \"USDC\". Null if not stated — default to USDC if the user clearly means a stablecoin offramp but didn't name one. Offramp only."),
  sourceChain: z.string().nullable().describe("The lowercase chain key the user is sending from, matching one of the allowed values. Null if not stated or unclear. Offramp only."),
  destinationCurrency: z.string().nullable().describe("The 3-letter fiat currency code the recipient should be paid in, inferred from context (e.g. a Nigerian bank implies NGN) if not stated explicitly. Null only if truly unclear. Offramp only."),
  institutionName: z.string().nullable().describe("The recipient's bank or mobile-money provider, as free text exactly as the user wrote it (do not correct spelling). Null if not stated. Offramp only."),
  accountIdentifier: z.string().nullable().describe("The recipient's account number or phone number, digits only. Null if not stated. Offramp only."),
  // Onramp fields.
  fiatAmount: z.string().nullable().describe("The fiat amount the user wants to pay in, as a plain string. Null if not stated. Onramp only."),
  fiatCurrency: z.string().nullable().describe("The 3-letter fiat currency code the user is paying in. Null if not stated or unclear. Onramp only."),
  destinationStellarAddress: z.string().nullable().describe("The Stellar G... address that should receive the USDC. Null if not stated. Onramp only."),
  refundInstitutionName: z.string().nullable().describe("The bank the user wants refunded if the fiat payment can't be matched, as free text exactly as written. Null if not stated. Onramp only."),
  refundAccountIdentifier: z.string().nullable().describe("The refund bank account number, digits only. Null if not stated. Onramp only."),
});
```

- [ ] **Step 2: Update the system prompt**

Find:

```ts
      system:
        `You extract offramp order details from a conversation between a user ` +
        `and Settu's offramp agent. The user wants to send crypto and have it ` +
        `paid out as fiat. Only use these source chains: ${chains.join(", ")}. ` +
        `Only use these destination currencies: ${currencyCodes}. ` +
        `Read the WHOLE conversation, not just the latest message — earlier ` +
        `turns may have already supplied fields the latest message doesn't ` +
        `repeat. Never invent a value that wasn't stated or clearly implied.`,
```

and replace it with:

```ts
      system:
        `You extract order details from a conversation between a user and ` +
        `Settu's crypto agent. The user wants EITHER to onramp (pay fiat, ` +
        `receive USDC on Stellar) OR offramp (send crypto, receive a fiat ` +
        `payout) — figure out which from context and set "direction" ` +
        `accordingly; only fill in the fields for that direction, leave ` +
        `every field for the other direction null. Only use these source ` +
        `chains for offramp: ${chains.join(", ")}. Only use these currencies ` +
        `for either direction: ${currencyCodes}. ` +
        `Read the WHOLE conversation, not just the latest message — earlier ` +
        `turns may have already supplied fields the latest message doesn't ` +
        `repeat. Never invent a value that wasn't stated or clearly implied.`,
```

- [ ] **Step 3: Add direction resolution and branch the handler**

Find:

```ts
    const typedExtraction: AgentOrderExtraction = extraction;
    const classified = classifyExtraction(typedExtraction);
    if (classified.status === "clarify") {
      return NextResponse.json({ kind: "clarify", message: classified.message });
    }
    if (classified.status === "recap") {
      return NextResponse.json({ kind: "recap", missing: classified.missing });
    }

    const resolved = await resolveAgentOrder(typedExtraction);
    if (resolved.status === "clarify") {
      return NextResponse.json({ kind: "clarify", message: resolved.message });
    }
    if (resolved.status === "recap") {
      return NextResponse.json({ kind: "recap", missing: resolved.missing });
    }

    // Pull the live quote now, before the user ever sees a confirmation
    // card — the card must show real numbers (rate, payout), and reusing
    // this exact fetch at confirm time means there's no second, unseen
    // quote the user never agreed to.
    const quoteRes = await fetch(new URL("/api/offramp/quote", request.nextUrl.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: resolved.order.amount,
        amountIn: "crypto",
        token: resolved.order.token,
        currency: resolved.order.beneficiary.currency,
        network: "base",
      }),
    });
    const quotePayload = await quoteRes.json().catch(() => ({}));
    if (!quoteRes.ok) {
      return NextResponse.json({
        kind: "clarify",
        message: quotePayload?.error || "Couldn't get a live rate — please try again in a moment.",
      });
    }

    return NextResponse.json({
      kind: "resolved",
      order: {
        ...resolved.order,
        rate: quotePayload.rate,
        destinationAmount: quotePayload.destinationAmount,
        estimatedTimeMs: quotePayload.estimatedTime,
      },
    });
```

and replace it with:

```ts
    // The model may leave "direction" null on a short/ambiguous first
    // message — fall back to which set of fields it actually populated.
    // Defaults to offramp when both/neither are populated, preserving the
    // existing behavior for a vague opening message.
    const looksOnramp = !!(
      extraction.fiatAmount ||
      extraction.fiatCurrency ||
      extraction.destinationStellarAddress ||
      extraction.refundInstitutionName ||
      extraction.refundAccountIdentifier
    );
    const looksOfframp = !!(
      extraction.amount ||
      extraction.token ||
      extraction.sourceChain ||
      extraction.institutionName ||
      extraction.accountIdentifier
    );
    const direction = extraction.direction ?? (looksOnramp && !looksOfframp ? "onramp" : "offramp");

    if (direction === "onramp") {
      const typedOnrampExtraction: OnrampAgentExtraction = {
        fiatAmount: extraction.fiatAmount,
        fiatCurrency: extraction.fiatCurrency,
        destinationStellarAddress: extraction.destinationStellarAddress,
        refundInstitutionName: extraction.refundInstitutionName,
        refundAccountIdentifier: extraction.refundAccountIdentifier,
      };
      const classifiedOnramp = classifyOnrampExtraction(typedOnrampExtraction);
      if (classifiedOnramp.status === "clarify") {
        return NextResponse.json({ kind: "clarify", message: classifiedOnramp.message });
      }
      if (classifiedOnramp.status === "recap") {
        return NextResponse.json({ kind: "recap", missing: classifiedOnramp.missing });
      }

      const resolvedOnramp = await resolveOnrampOrder(typedOnrampExtraction);
      if (resolvedOnramp.status === "clarify") {
        return NextResponse.json({ kind: "clarify", message: resolvedOnramp.message });
      }
      if (resolvedOnramp.status === "recap") {
        return NextResponse.json({ kind: "recap", missing: resolvedOnramp.missing });
      }

      // No quote to pull here — Paycrest doesn't return a rate until the
      // order actually exists, unlike offramp's pre-fetched quote above.
      return NextResponse.json({ kind: "resolved-onramp", order: resolvedOnramp.order });
    }

    const typedExtraction: AgentOrderExtraction = extraction;
    const classified = classifyExtraction(typedExtraction);
    if (classified.status === "clarify") {
      return NextResponse.json({ kind: "clarify", message: classified.message });
    }
    if (classified.status === "recap") {
      return NextResponse.json({ kind: "recap", missing: classified.missing });
    }

    const resolved = await resolveAgentOrder(typedExtraction);
    if (resolved.status === "clarify") {
      return NextResponse.json({ kind: "clarify", message: resolved.message });
    }
    if (resolved.status === "recap") {
      return NextResponse.json({ kind: "recap", missing: resolved.missing });
    }

    // Pull the live quote now, before the user ever sees a confirmation
    // card — the card must show real numbers (rate, payout), and reusing
    // this exact fetch at confirm time means there's no second, unseen
    // quote the user never agreed to.
    const quoteRes = await fetch(new URL("/api/offramp/quote", request.nextUrl.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: resolved.order.amount,
        amountIn: "crypto",
        token: resolved.order.token,
        currency: resolved.order.beneficiary.currency,
        network: "base",
      }),
    });
    const quotePayload = await quoteRes.json().catch(() => ({}));
    if (!quoteRes.ok) {
      return NextResponse.json({
        kind: "clarify",
        message: quotePayload?.error || "Couldn't get a live rate — please try again in a moment.",
      });
    }

    return NextResponse.json({
      kind: "resolved",
      order: {
        ...resolved.order,
        rate: quotePayload.rate,
        destinationAmount: quotePayload.destinationAmount,
        estimatedTimeMs: quotePayload.estimatedTime,
      },
    });
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (`extraction` from `generateObject` now has more nullable fields — the existing `typedExtraction: AgentOrderExtraction = extraction` assignment still works since `AgentOrderExtraction` only requires the 6 offramp fields, and the inferred Zod type is a structural superset.)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all existing tests pass unchanged (this route has no unit tests of its own — it's covered by the resolver-level tests plus manual/live verification in Task 8).

- [ ] **Step 6: Run the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/offramp/agent/parse/route.ts
git commit -m "feat(offramp): detect onramp vs offramp intent in the agent parse route"
```

---

### Task 7: `AgentPanel.tsx` — onramp confirmation card, virtual-account card, SSE narration

**Files:**
- Modify: `src/components/AgentPanel.tsx`

**Interfaces:**
- Consumes: `ResolvedOnrampOrder` (type-only) from `@/lib/offramp/agent-onramp-resolver`; `onrampStatusToAgentEvent`, `type OnrampStepEvent` from `@/lib/offramp/agent-onramp-step-bridge`; `createOnrampOrder`, `type CreateOnrampOrderResult` from `@/lib/onramp/client`.
- Produces: `AgentPanelProps` gains `onInitiateOnramp: (order: ResolvedOnrampOrder) => Promise<CreateOnrampOrderResult>` — consumed by `StellarampDashboard.tsx` (Task 8).

- [ ] **Step 1: Add imports and new `ChatMessage` fields**

At the top of `src/components/AgentPanel.tsx`, add these imports alongside the existing ones:

```ts
import type { ResolvedOnrampOrder } from "@/lib/offramp/agent-onramp-resolver";
import { onrampStatusToAgentEvent } from "@/lib/offramp/agent-onramp-step-bridge";
import { createOnrampOrder, type CreateOnrampOrderResult } from "@/lib/onramp/client";
```

Find the `ParseResponse` type:

```ts
type ParseResponse =
  | { kind: "clarify"; message: string }
  | { kind: "recap"; missing: string[] }
  | { kind: "resolved"; order: AgentOrderWithQuote }
  | { kind: "error"; message: string };
```

and add the new variant:

```ts
type ParseResponse =
  | { kind: "clarify"; message: string }
  | { kind: "recap"; missing: string[] }
  | { kind: "resolved"; order: AgentOrderWithQuote }
  | { kind: "resolved-onramp"; order: ResolvedOnrampOrder }
  | { kind: "error"; message: string };
```

Find the `ChatMessage` interface:

```ts
interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text?: string;
  order?: AgentOrderWithQuote; // present only on the confirmation-card message
  // Lifecycle of a confirmation card: undefined until Confirm/Cancel is
  // clicked, "confirmed" while the run is in flight, then "success"/"failed"
  // once offrampStep resolves (or "cancelled" if declined or aborted mid-run).
  orderStatus?: "confirmed" | "success" | "failed" | "cancelled";
  stepKind?: AgentStepEvent["kind"]; // present only on step-narration messages
}
```

and add the onramp fields:

```ts
interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text?: string;
  order?: AgentOrderWithQuote; // present only on the confirmation-card message
  // Lifecycle of a confirmation card: undefined until Confirm/Cancel is
  // clicked, "confirmed" while the run is in flight, then "success"/"failed"
  // once offrampStep resolves (or "cancelled" if declined or aborted mid-run).
  orderStatus?: "confirmed" | "success" | "failed" | "cancelled";
  stepKind?: AgentStepEvent["kind"]; // present only on step-narration messages
  onrampOrder?: ResolvedOnrampOrder; // present only on the onramp confirmation-card message
  // Same lifecycle shape as orderStatus, but a pre-creation failure clears
  // back to undefined instead of "failed" — nothing was created yet, so the
  // card should stay retryable rather than presenting a dead end.
  onrampOrderStatus?: "confirmed" | "success" | "failed" | "cancelled";
  virtualAccount?: {
    orderId: string;
    account: CreateOnrampOrderResult["providerAccount"];
  }; // present only on the post-confirm account-details message
}
```

- [ ] **Step 2: Add the `onInitiateOnramp` prop**

Find:

```ts
export interface AgentPanelProps {
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly onConnect: () => void;
  // Which chain the currently connected (or last-selected) wallet is on —
  // set by the Off-ramp tab's source-chain dropdown, not by Agent Mode
  // itself. A resolved order can name any supported chain regardless of
  // this, so confirmOrder checks the two match before ever touching
  // onInitiateOfframp.
  readonly activeSourceChain: AgentOrderWithQuote["sourceChain"];
  readonly sourceChainLabel: string;
  readonly offrampStep: OfframpStep;
  readonly offrampError: string | null;
  readonly active: boolean;
  readonly onCancelFlow: () => void;
  readonly onInitiateOfframp: (tradeData: {
    amount: string;
    rate: number;
    destinationAmount: string;
    token: string;
    sourceChain: AgentOrderWithQuote["sourceChain"];
    beneficiary: AgentOrderWithQuote["beneficiary"];
  }) => Promise<void> | void;
}
```

and add the new prop at the end:

```ts
export interface AgentPanelProps {
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly onConnect: () => void;
  // Which chain the currently connected (or last-selected) wallet is on —
  // set by the Off-ramp tab's source-chain dropdown, not by Agent Mode
  // itself. A resolved order can name any supported chain regardless of
  // this, so confirmOrder checks the two match before ever touching
  // onInitiateOfframp.
  readonly activeSourceChain: AgentOrderWithQuote["sourceChain"];
  readonly sourceChainLabel: string;
  readonly offrampStep: OfframpStep;
  readonly offrampError: string | null;
  readonly active: boolean;
  readonly onCancelFlow: () => void;
  readonly onInitiateOfframp: (tradeData: {
    amount: string;
    rate: number;
    destinationAmount: string;
    token: string;
    sourceChain: AgentOrderWithQuote["sourceChain"];
    beneficiary: AgentOrderWithQuote["beneficiary"];
  }) => Promise<void> | void;
  // No isConnected/onConnect gate needed for onramp — the destination
  // Stellar address is always given explicitly in the conversation.
  readonly onInitiateOnramp: (order: ResolvedOnrampOrder) => Promise<CreateOnrampOrderResult>;
}
```

Then update the destructured props in the component signature — find:

```ts
export function AgentPanel({
  isConnected,
  isConnecting,
  onConnect,
  activeSourceChain,
  sourceChainLabel,
  offrampStep,
  offrampError,
  active,
  onCancelFlow,
  onInitiateOfframp,
}: Readonly<AgentPanelProps>) {
```

and add the new prop:

```ts
export function AgentPanel({
  isConnected,
  isConnecting,
  onConnect,
  activeSourceChain,
  sourceChainLabel,
  offrampStep,
  offrampError,
  active,
  onCancelFlow,
  onInitiateOfframp,
  onInitiateOnramp,
}: Readonly<AgentPanelProps>) {
```

- [ ] **Step 3: Handle the new `resolved-onramp` response kind in `send()`**

Find, inside `send()`:

```ts
      } else if (data.kind === "resolved") {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "agent", order: data.order },
        ]);
      } else {
```

and insert a new branch before the `else`:

```ts
      } else if (data.kind === "resolved") {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "agent", order: data.order },
        ]);
      } else if (data.kind === "resolved-onramp") {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "agent", onrampOrder: data.order },
        ]);
      } else {
```

- [ ] **Step 4: Add `confirmOnrampOrder` and `cancelOnrampOrder`**

Add these two functions right after the existing `cancelFlowAndOrder` function (after its closing `};`):

```ts
  const confirmOnrampOrder = async (order: ResolvedOnrampOrder) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.onrampOrder === order ? { ...m, onrampOrderStatus: "confirmed" } : m,
      ),
    );
    try {
      const result = await onInitiateOnramp(order);
      setMessages((prev) => [
        ...prev.map((m) =>
          m.onrampOrder === order ? { ...m, onrampOrderStatus: "success" as const } : m,
        ),
        {
          id: nextId(),
          role: "agent",
          virtualAccount: { orderId: result.id, account: result.providerAccount },
        },
      ]);

      const source = new EventSource(`/api/onramp/stream/${result.id}`);
      const lastOnrampStatus = { current: "" };
      source.onmessage = (evt) => {
        let payload: { status?: string; stellarTxHash?: string };
        try {
          payload = JSON.parse(evt.data);
        } catch {
          return;
        }
        if (!payload.status || payload.status === lastOnrampStatus.current) return;
        lastOnrampStatus.current = payload.status;
        const event = onrampStatusToAgentEvent(payload.status, {
          stellarTxHash: payload.stellarTxHash,
        });
        if (!event) return;
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "agent", text: event.text, stepKind: event.kind },
        ]);
        if (payload.status === "delivered" || payload.status === "refunded" || payload.status === "expired") {
          source.close();
        }
      };
      source.onerror = () => {
        // The stream itself auto-reconnects on the server side across
        // reconnects; a client-side error here just means this particular
        // connection dropped. Nothing to narrate — the next successful
        // message picks up wherever the order actually is.
      };
    } catch (e: any) {
      // Nothing was created — clear the status (not "failed") so
      // Confirm/Cancel reappear and the user can just retry.
      setMessages((prev) => [
        ...prev.map((m) =>
          m.onrampOrder === order ? { ...m, onrampOrderStatus: undefined } : m,
        ),
        {
          id: nextId(),
          role: "agent",
          text: e?.message || "Something went wrong creating that order — please try again.",
          stepKind: "error",
        },
      ]);
    }
  };

  const cancelOnrampOrder = (order: ResolvedOnrampOrder) => {
    setMessages((prev) => [
      ...prev.map((m) =>
        m.onrampOrder === order ? { ...m, onrampOrderStatus: "cancelled" as const } : m,
      ),
      {
        id: nextId(),
        role: "agent",
        text: "Cancelled — send a new message whenever you're ready.",
      },
    ]);
  };
```

- [ ] **Step 5: Render the onramp confirmation card**

Find the closing of the existing offramp card block — the code reads (searching for the end of the `if (m.order) { ... }` block):

```ts
                    {m.orderStatus === "failed" && (
                      <div className="mt-[0.7rem] py-[0.4rem] text-center text-[0.72rem] font-bold uppercase tracking-[0.08em] text-red-400">
                        ✗ Failed
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            return (
```

Insert a new `if (m.onrampOrder)` block between that closing `}` (of `if (m.order)`) and `return (` — i.e. change it to:

```ts
                    {m.orderStatus === "failed" && (
                      <div className="mt-[0.7rem] py-[0.4rem] text-center text-[0.72rem] font-bold uppercase tracking-[0.08em] text-red-400">
                        ✗ Failed
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            if (m.onrampOrder) {
              const o = m.onrampOrder;
              return (
                <div key={m.id} className="flex justify-start">
                  <div className="max-w-[92%] border border-[var(--line)] bg-[#101010] p-[0.8rem]">
                    <div className="mb-[0.55rem] text-[0.62rem] uppercase tracking-[0.1em] text-[var(--muted)]">
                      Onramp Summary
                    </div>
                    {[
                      ["Amount", `${o.fiatAmount} ${o.currency}`],
                      ["Destination", `${o.destinationAddress.slice(0, 6)}…${o.destinationAddress.slice(-6)}`],
                      ["Refund bank", o.refundAccount.institution],
                      ["Refund account", o.refundAccount.accountIdentifier],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="flex justify-between gap-[0.6rem] border-b border-dashed border-[#222] py-[0.22rem] text-[0.78rem]"
                      >
                        <span className="text-[var(--muted)]">{label}</span>
                        <span className="text-right">{value}</span>
                      </div>
                    ))}
                    <div className="flex justify-between gap-[0.6rem] py-[0.22rem] text-[0.78rem]">
                      <span className="shrink-0 text-[var(--muted)]">Refund account name</span>
                      <span className="text-right text-[var(--accent)]">
                        {o.refundAccount.accountName} ✓ verified
                      </span>
                    </div>
                    {!m.onrampOrderStatus && (
                      <div className="mt-[0.7rem] flex gap-[0.5rem]">
                        <button
                          type="button"
                          onClick={() => confirmOnrampOrder(o)}
                          className="flex-1 bg-[var(--accent)] py-[0.55rem] text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[#0a0a0a] disabled:opacity-50"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => cancelOnrampOrder(o)}
                          className="flex-1 border border-[var(--line)] py-[0.55rem] text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[var(--muted)] disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    {m.onrampOrderStatus === "success" && (
                      <div className="mt-[0.7rem] py-[0.4rem] text-center text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[var(--accent)]">
                        ✓ Order created
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            if (m.virtualAccount) {
              const { account } = m.virtualAccount;
              return (
                <div key={m.id} className="flex justify-start">
                  <div className="max-w-[92%] border border-[var(--line)] bg-[#101010] p-[0.8rem]">
                    <div className="mb-[0.55rem] text-[0.62rem] uppercase tracking-[0.1em] text-[var(--muted)]">
                      Pay Into This Account
                    </div>
                    {[
                      ["Bank", account.institution],
                      ["Account number", account.accountIdentifier],
                      ["Account name", account.accountName],
                      ["Amount", `${account.amountToTransfer} ${account.currency}`],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="flex justify-between gap-[0.6rem] border-b border-dashed border-[#222] py-[0.22rem] text-[0.78rem]"
                      >
                        <span className="text-[var(--muted)]">{label}</span>
                        <span className="text-right font-bold text-[var(--accent)]">{value}</span>
                      </div>
                    ))}
                    <div className="flex justify-between gap-[0.6rem] py-[0.22rem] text-[0.78rem]">
                      <span className="text-[var(--muted)]">Valid until</span>
                      <span className="text-right">{account.validUntil}</span>
                    </div>
                  </div>
                </div>
              );
            }
            return (
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Run the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/components/AgentPanel.tsx
git commit -m "feat(onramp): confirmation + virtual-account cards and SSE narration in Agent Mode"
```

---

### Task 8: Wire `onInitiateOnramp` into `StellarampDashboard.tsx`

**Files:**
- Modify: `src/components/StellarampDashboard.tsx`

**Interfaces:**
- Consumes: `createOnrampOrder` from `@/lib/onramp/client` (Task 3); `type ResolvedOnrampOrder` from `@/lib/offramp/agent-onramp-resolver` (Task 4).

**Task Note:** `createOnrampOrder`'s parameter shape (`CreateOnrampOrderInput`: `fiatAmount, currency, userStellarAddress, refundAccount: {institution, accountIdentifier, accountName}`) does NOT match `ResolvedOnrampOrder`'s shape (`fiatAmount, currency, destinationAddress, refundAccount: {institution, accountIdentifier, accountName, currency}`) — the field is named `destinationAddress` vs `userStellarAddress`, and `refundAccount` carries an extra `currency`. `AgentPanel`'s `onInitiateOnramp` prop takes a `ResolvedOnrampOrder`, so it cannot be `createOnrampOrder` directly — a small adapter function does the field mapping.

- [ ] **Step 1: Import the shared client helper and the resolved-order type**

Add these imports alongside `StellarampDashboard.tsx`'s other `@/lib/...` imports:

```ts
import { createOnrampOrder } from "@/lib/onramp/client";
import type { ResolvedOnrampOrder } from "@/lib/offramp/agent-onramp-resolver";
```

- [ ] **Step 2: Add the adapter function**

Add this function near `handleAgentInitiateOfframp` (both are thin Agent-Mode-specific wrappers passed down to `AgentPanel`):

```ts
  // ResolvedOnrampOrder (Agent Mode's shape) and CreateOnrampOrderInput
  // (the order-creation route's shape) differ slightly — destinationAddress
  // vs userStellarAddress, and refundAccount carries an extra currency
  // field Agent Mode's resolver includes for symmetry with offramp's
  // beneficiary shape. This just maps one to the other.
  const handleAgentInitiateOnramp = (order: ResolvedOnrampOrder) =>
    createOnrampOrder({
      fiatAmount: order.fiatAmount,
      currency: order.currency,
      userStellarAddress: order.destinationAddress,
      refundAccount: {
        institution: order.refundAccount.institution,
        accountIdentifier: order.refundAccount.accountIdentifier,
        accountName: order.refundAccount.accountName,
      },
    });
```

- [ ] **Step 3: Pass it to `AgentPanel`**

Find the `<AgentPanel ... />` usage (it currently ends with `onInitiateOfframp={handleAgentInitiateOfframp}`):

```ts
                    <AgentPanel
                      isConnected={uiIsConnected}
                      isConnecting={uiIsConnecting}
                      onConnect={handleConnect}
                      activeSourceChain={sourceChain}
                      sourceChainLabel={activeSourceChainLabel}
                      offrampStep={offrampStep}
                      offrampError={offrampError}
                      active={offrampInitiator === "agent"}
                      onCancelFlow={handleCancelOfframpFlow}
                      onInitiateOfframp={handleAgentInitiateOfframp}
                    />
```

and add the new prop:

```ts
                    <AgentPanel
                      isConnected={uiIsConnected}
                      isConnecting={uiIsConnecting}
                      onConnect={handleConnect}
                      activeSourceChain={sourceChain}
                      sourceChainLabel={activeSourceChainLabel}
                      offrampStep={offrampStep}
                      offrampError={offrampError}
                      active={offrampInitiator === "agent"}
                      onCancelFlow={handleCancelOfframpFlow}
                      onInitiateOfframp={handleAgentInitiateOfframp}
                      onInitiateOnramp={handleAgentInitiateOnramp}
                    />
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the build and full test suite**

Run: `npm run build && npm test`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/components/StellarampDashboard.tsx
git commit -m "feat(onramp): wire onInitiateOnramp into Agent Mode from the dashboard"
```

---

### Task 9: Live verification

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Switch to the Agent tab and send an onramp message**

In the browser, type something like: "I want to buy 50000 NGN of USDC, send it to GALC4XJL55YPA7WLS3VDK3IOZDQ4LF5ZXO422EJZ34MPFI44NPXZOQCR, refund to my OPay account 0987654321 John Doe."

Expected: the agent extracts the details (asking a clarifying question first if anything's missing/ambiguous) and shows the onramp confirmation card with amount, destination address (truncated), refund bank, and verified refund account name.

- [ ] **Step 3: Confirm the order**

Click Confirm. Expected: the card shows "✓ Order created", and a new "Pay Into This Account" card appears with a real Paycrest virtual account (bank, account number, account name, exact amount, expiry). Immediately after, a "Waiting for your bank transfer…" narration message appears and a typing indicator or subsequent narration should NOT get stuck — confirm the EventSource connected by checking the Network tab for an open `text/event-stream` request to `/api/onramp/stream/<id>`.

- [ ] **Step 4: Verify a mid-conversation direction switch still works**

In the same chat (or a fresh reload), send an offramp-shaped message ("Offramp 10 USDC on Base to my OPay account 0987654321 Jane Doe") and confirm it still produces the existing offramp confirmation card, unaffected by this change.

- [ ] **Step 5: Verify OnrampPanel (the Off-ramp tab's sibling) is unaffected**

Switch to the On-ramp tab, fill the form, and confirm it still creates an order and shows the virtual-account view exactly as before (Tasks 2-3 were pure refactors of this exact path).

- [ ] **Step 6: Report results**

If anything in steps 2-5 doesn't match, stop and fix the specific failing piece before considering this plan complete — do not proceed to closing out the branch on an unverified live path.
