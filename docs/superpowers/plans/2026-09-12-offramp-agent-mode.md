# Offramp Agent Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a chat-based "Agent" tab to the offramp UI where a free-text sentence ("Offramp 1,000 USDC on Base to my NGN OPay 0987654321, John Doe") drives the exact same offramp pipeline the form already uses, narrated as chat messages instead of the form + progress modal.

**Architecture:** A new `AgentPanel` component sits alongside `FormCard` in the same grid slot. It posts the conversation to a server route that extracts structured order fields via an LLM (Vercel AI Gateway, structured output), then a resolver verifies the bank/account/quote against Paycrest's real data before ever showing a confirmation card. Confirming calls the *same* `handleExecuteTrade` dispatcher the form's button calls — no changes to execution, CCTP, or Paycrest order logic. A small pure "step bridge" turns the existing `offrampStep` state machine into chat messages instead of `TransactionProgressModal`'s stepper.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Vercel AI SDK (`ai`) against the AI Gateway, Zod for structured-output schemas, existing Paycrest public API + Settu's own `/api/offramp/quote` route, `node --test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-09-12-offramp-agent-mode-design.md`

## Global Constraints

- **Non-custodial stays non-custodial.** Agent Mode never signs or submits anything itself — Confirm only ever calls the same `handleExecuteTrade` the form calls, which still requires the user's own wallet signature.
- **Never execute from a raw LLM parse.** A confirmation card is only ever shown after the bank name resolves to a real institution code, the account number verifies to a real account name via Paycrest, and a live quote has been pulled — the same checks the form already runs, just run once instead of reactively.
- **`handleExecuteTrade`, `handleExecuteEvmTrade`, `handleExecuteSolanaTrade` are not modified.** Agent Mode is purely a new caller and a new consumer of their existing output (`offrampStep`, `tradeState`, `offrampError`).
- **v1 is offramp only**, across every source chain the form already supports (Stellar, EVM chains, Solana) — not restricted to Stellar.
- Every scrollable area in the app gets the same custom scrollbar (black track, gold thumb) — decided during the design pass, unrelated to Agent Mode's own logic but shipped in the same body of work.

---

## Task 1: App-wide custom scrollbar theme

**Files:**
- Modify: `src/app/globals.css`

**Interfaces:** None — pure CSS, no other task depends on this.

- [ ] **Step 1: Add the scrollbar rules**

Add this block near the top of `src/app/globals.css`, right after the existing `:root { ... }` block (which already defines `--accent: #c9a962;`):

```css
/* Custom scrollbar — every scrollable area in the app. Black track, gold
   thumb, no border-radius (nothing in this app's UI is rounded). */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--accent) var(--bg);
}
::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
::-webkit-scrollbar-track {
  background: var(--bg);
}
::-webkit-scrollbar-thumb {
  background: var(--accent);
  border: 2px solid var(--bg);
}
::-webkit-scrollbar-thumb:hover {
  background: #f4e1ad;
}
```

- [ ] **Step 2: Verify visually**

Run: `npm run dev`
Open the app, resize the browser small enough that any panel scrolls (or open dev tools' device toolbar), and confirm the scrollbar is a black track with a gold thumb rather than the OS default.

- [ ] **Step 3: Commit**

```bash
git add src/app/globals.css
git commit -m "feat(ui): app-wide gold-on-black scrollbar theme"
```

---

## Task 2: Extract `sourceChainOptions()` as a shared, testable helper

**Why:** `FormCard.tsx` currently builds its chain dropdown list as a private module-level constant. The agent's LLM schema needs the exact same enabled-chain list (so it never proposes a chain that's feature-flagged off), so this becomes a shared function instead of being duplicated.

**Files:**
- Create: `src/lib/offramp/source-chain-options.ts`
- Create: `src/lib/offramp/source-chain-options.test.ts`
- Modify: `src/components/FormCard.tsx:15-31`

**Interfaces:**
- Produces: `sourceChainOptions(): { code: OfframpSourceChainKey; name: string }[]`, `type OfframpSourceChainKey = "stellar" | EvmChainKey | "solana"` (moved here from `FormCard.tsx`, re-exported from `FormCard.tsx` for backward compatibility with existing imports).

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/offramp/source-chain-options.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { sourceChainOptions } from "./source-chain-options";

test("stellar is always first and always present", () => {
  const options = sourceChainOptions();
  assert.equal(options[0].code, "stellar");
  assert.equal(options[0].name, "Stellar");
});

test("every option has a non-empty code and name", () => {
  for (const option of sourceChainOptions()) {
    assert.ok(option.code.length > 0);
    assert.ok(option.name.length > 0);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/source-chain-options.test.ts`
Expected: FAIL — `Cannot find module './source-chain-options'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/offramp/source-chain-options.ts
import {
  EVM_SOURCE_CHAINS,
  isChainEnabled,
  type EvmChainKey,
} from "../cctp/evm-chains";
import { isSolanaEnabled } from "../solana/config";

export type OfframpSourceChainKey = "stellar" | EvmChainKey | "solana";

export interface SourceChainOption {
  code: OfframpSourceChainKey;
  name: string;
}

/**
 * "Stellar" plus every non-Stellar chain turned on via
 * NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED. Shared by FormCard's dropdown
 * and the agent's LLM schema so both only ever offer chains that are
 * actually live — computed fresh each call (env-driven, not memoized) so a
 * test can flip env vars between calls.
 */
export function sourceChainOptions(): SourceChainOption[] {
  return [
    { code: "stellar", name: "Stellar" },
    ...Object.values(EVM_SOURCE_CHAINS)
      .filter((c) => isChainEnabled(c.key))
      .map((c) => ({ code: c.key as OfframpSourceChainKey, name: c.label })),
    ...(isSolanaEnabled()
      ? [{ code: "solana" as OfframpSourceChainKey, name: "Solana" }]
      : []),
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/source-chain-options.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Point `FormCard.tsx` at the shared helper**

In `src/components/FormCard.tsx`, replace lines 15-31:

```typescript
export type OfframpSourceChainKey = "stellar" | EvmChainKey | "solana";

/**
 * "Stellar" plus every non-Stellar chain turned on via
 * NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED. Until that var lists something
 * this is just `[{ stellar }]` and the dropdown is hidden — today's
 * single-source flow, unchanged. Computed once at module load.
 */
const SOURCE_CHAIN_OPTIONS: { code: OfframpSourceChainKey; name: string }[] = [
  { code: "stellar", name: "Stellar" },
  ...Object.values(EVM_SOURCE_CHAINS)
    .filter((c) => isChainEnabled(c.key))
    .map((c) => ({ code: c.key as OfframpSourceChainKey, name: c.label })),
  ...(isSolanaEnabled()
    ? [{ code: "solana" as OfframpSourceChainKey, name: "Solana" }]
    : []),
];
```

with:

```typescript
export { type OfframpSourceChainKey } from "@/lib/offramp/source-chain-options";
import { sourceChainOptions } from "@/lib/offramp/source-chain-options";

// Recomputed on every render (cheap — a handful of filter/map calls), unlike
// the old module-level constant, so a runtime env change during dev doesn't
// need a full reload to show up.
const SOURCE_CHAIN_OPTIONS = sourceChainOptions();
```

Remove the now-unused `EVM_SOURCE_CHAINS`, `isChainEnabled`, `isSolanaEnabled` imports at the top of `FormCard.tsx` **only if** nothing else in the file still uses them — check with `grep -n "EVM_SOURCE_CHAINS\|isChainEnabled\|isSolanaEnabled" src/components/FormCard.tsx` first, since `EVM_SOURCE_CHAINS` in particular is likely used elsewhere in the file (e.g. `nativeCurrencySymbol` lookups).

- [ ] **Step 6: Verify the app still builds and the dropdown still works**

Run: `npx tsc --noEmit && npm run build`
Expected: both clean. Then `npm run dev`, open the offramp form, confirm the source-chain dropdown still lists the same chains as before.

- [ ] **Step 7: Commit**

```bash
git add src/lib/offramp/source-chain-options.ts src/lib/offramp/source-chain-options.test.ts src/components/FormCard.tsx
git commit -m "refactor(offramp): extract sourceChainOptions as a shared helper"
```

---

## Task 3: `agent-step-bridge` — turn `offrampStep` into chat messages

**Files:**
- Create: `src/lib/offramp/agent-step-bridge.ts`
- Create: `src/lib/offramp/agent-step-bridge.test.ts`

**Interfaces:**
- Consumes: `OfframpStep` (from `@/components/TransactionProgressModal`, values: `"idle" | "initiating" | "awaiting-signature" | "submitting" | "processing" | "settling" | "success" | "error"`).
- Produces: `stepToAgentEvent(step: OfframpStep, opts: { sourceChainLabel: string; error?: string | null }): AgentStepEvent | null`, `interface AgentStepEvent { id: string; kind: "progress" | "success" | "error"; text: string; }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/offramp/agent-step-bridge.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { stepToAgentEvent } from "./agent-step-bridge";

test("idle produces no message", () => {
  assert.equal(stepToAgentEvent("idle", { sourceChainLabel: "Base" }), null);
});

test("awaiting-signature asks the user to check their wallet", () => {
  const event = stepToAgentEvent("awaiting-signature", { sourceChainLabel: "Base" });
  assert.equal(event?.kind, "progress");
  assert.match(event!.text, /wallet/i);
});

test("submitting names the source chain", () => {
  const event = stepToAgentEvent("submitting", { sourceChainLabel: "Solana" });
  assert.match(event!.text, /Solana/);
});

test("error uses the supplied error text verbatim, not a generic message", () => {
  const event = stepToAgentEvent("error", {
    sourceChainLabel: "Base",
    error: "Insufficient USDC balance. You have 2.00 USDC but are trying to send 5 USDC.",
  });
  assert.equal(event?.kind, "error");
  assert.match(event!.text, /Insufficient USDC balance/);
});

test("error with no supplied text still returns a usable message", () => {
  const event = stepToAgentEvent("error", { sourceChainLabel: "Base", error: null });
  assert.equal(event?.kind, "error");
  assert.ok(event!.text.length > 0);
});

test("success is a distinct kind", () => {
  const event = stepToAgentEvent("success", { sourceChainLabel: "Base" });
  assert.equal(event?.kind, "success");
});

test("every non-idle step has a unique, stable id per step value", () => {
  const steps = ["initiating", "awaiting-signature", "submitting", "processing", "settling", "success", "error"] as const;
  const ids = steps.map((s) => stepToAgentEvent(s, { sourceChainLabel: "Base" })!.id);
  assert.equal(new Set(ids).size, ids.length);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/agent-step-bridge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/offramp/agent-step-bridge.ts
import type { OfframpStep } from "@/components/TransactionProgressModal";

export interface AgentStepEvent {
  /** Stable per step value — lets the caller de-dupe if the same step fires twice. */
  id: string;
  kind: "progress" | "success" | "error";
  text: string;
}

/**
 * Maps an `offrampStep` transition to a chat message, so AgentPanel can
 * narrate execution the way TransactionProgressModal renders it as a
 * stepper. Pure and synchronous — no access to `tradeState` beyond what's
 * passed in, so it's fully unit-testable without running an offramp.
 */
export function stepToAgentEvent(
  step: OfframpStep,
  opts: { sourceChainLabel: string; error?: string | null },
): AgentStepEvent | null {
  switch (step) {
    case "idle":
      return null;
    case "initiating":
      return { id: "initiating", kind: "progress", text: "Starting your offramp…" };
    case "awaiting-signature":
      return {
        id: "awaiting-signature",
        kind: "progress",
        text: "Confirm the transaction in your wallet…",
      };
    case "submitting":
      return {
        id: "submitting",
        kind: "progress",
        text: `Submitting on ${opts.sourceChainLabel}…`,
      };
    case "processing":
      return { id: "processing", kind: "progress", text: "Transaction processing…" };
    case "settling":
      return {
        id: "settling",
        kind: "progress",
        text: "Confirming settlement in fiat…",
      };
    case "success":
      return { id: "success", kind: "success", text: "✅ Offramp complete." };
    case "error":
      return {
        id: "error",
        kind: "error",
        text: `❌ ${opts.error || "Something went wrong — please try again."}`,
      };
    default: {
      const exhaustive: never = step;
      return exhaustive;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/agent-step-bridge.test.ts`
Expected: PASS (7/7)

- [ ] **Step 5: Commit**

```bash
git add src/lib/offramp/agent-step-bridge.ts src/lib/offramp/agent-step-bridge.test.ts
git commit -m "feat(offramp): pure offrampStep -> chat message mapping for Agent Mode"
```

---

## Task 4: `paycrest-directory` — shared fetch wrappers for currencies/institutions/verify-account

**Why:** The resolver (Task 5) needs the same three Paycrest lookups `FormCard.tsx` already does inline (currencies, institutions-by-currency, verify-account), but from a server route instead of the browser. Centralize them so there's one place that knows Paycrest's response shape.

**Files:**
- Create: `src/lib/offramp/paycrest-directory.ts`
- Create: `src/lib/offramp/paycrest-directory.test.ts`

**Interfaces:**
- Produces: `fetchCurrencies(): Promise<{ code: string; name: string; symbol: string }[]>`, `fetchInstitutions(currency: string): Promise<{ code: string; name: string; type?: string }[]>`, `verifyAccount(institution: string, accountIdentifier: string): Promise<string | null>` (returns the verified account name, or `null` if unverifiable — mirrors `FormCard`'s own "OK" sentinel handling).

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/offramp/paycrest-directory.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { fetchCurrencies, fetchInstitutions, verifyAccount } from "./paycrest-directory";

function withFetch(impl: typeof globalThis.fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

test("fetchCurrencies returns the data array", async () => {
  await withFetch(
    async () => jsonResponse({ data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }] }),
    async () => {
      const currencies = await fetchCurrencies();
      assert.equal(currencies.length, 1);
      assert.equal(currencies[0].code, "NGN");
    },
  );
});

test("fetchCurrencies returns an empty array on a non-ok response", async () => {
  await withFetch(
    async () => jsonResponse({}, false),
    async () => assert.deepEqual(await fetchCurrencies(), []),
  );
});

test("fetchInstitutions hits the right URL and returns the data array", async () => {
  let requestedUrl = "";
  await withFetch(
    async (url) => {
      requestedUrl = String(url);
      return jsonResponse({ data: [{ code: "OPAYNGPC", name: "OPay" }] });
    },
    async () => {
      const institutions = await fetchInstitutions("NGN");
      assert.equal(institutions[0].name, "OPay");
      assert.match(requestedUrl, /\/institutions\/NGN$/);
    },
  );
});

test("verifyAccount returns the verified name", async () => {
  await withFetch(
    async () => jsonResponse({ data: { accountName: "JOHN DOE" } }),
    async () => {
      assert.equal(await verifyAccount("OPAYNGPC", "0987654321"), "JOHN DOE");
    },
  );
});

test("verifyAccount treats the literal 'OK' sentinel as unverifiable", async () => {
  await withFetch(
    async () => jsonResponse({ data: { accountName: "OK" } }),
    async () => {
      assert.equal(await verifyAccount("SOMEBANK", "0987654321"), null);
    },
  );
});

test("verifyAccount returns null on a network/HTTP failure", async () => {
  await withFetch(
    async () => jsonResponse({}, false),
    async () => assert.equal(await verifyAccount("SOMEBANK", "0987654321"), null),
  );
  await withFetch(
    async () => {
      throw new Error("network down");
    },
    async () => assert.equal(await verifyAccount("SOMEBANK", "0987654321"), null),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/paycrest-directory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/offramp/paycrest-directory.ts
// Server-usable equivalents of the Paycrest public-API calls FormCard.tsx
// already makes from the browser (currencies, institutions, verify-account —
// none of these three need PAYCREST_API_KEY; they're public reference data).

const PAYCREST_API_BASE = "https://api.paycrest.io/v1";

export interface PaycrestCurrency {
  code: string;
  name: string;
  symbol: string;
}

export interface PaycrestInstitution {
  code: string;
  name: string;
  type?: string;
}

export async function fetchCurrencies(): Promise<PaycrestCurrency[]> {
  try {
    const res = await fetch(`${PAYCREST_API_BASE}/currencies`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data : [];
  } catch {
    return [];
  }
}

export async function fetchInstitutions(currency: string): Promise<PaycrestInstitution[]> {
  try {
    const res = await fetch(
      `${PAYCREST_API_BASE}/institutions/${encodeURIComponent(currency)}`,
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data : [];
  } catch {
    return [];
  }
}

/**
 * Returns the verified account holder name, or null if Paycrest couldn't
 * verify it (bad account number, unreachable, or the "OK" sentinel some
 * corridors — e.g. KES M-Pesa — return instead of a real name).
 */
export async function verifyAccount(
  institution: string,
  accountIdentifier: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${PAYCREST_API_BASE}/verify-account`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ institution, accountIdentifier }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.data?.accountName || data?.data || data?.accountName || "";
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name || name.toUpperCase() === "OK") return null;
    return name;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/paycrest-directory.test.ts`
Expected: PASS (6/6)

- [ ] **Step 5: Commit**

```bash
git add src/lib/offramp/paycrest-directory.ts src/lib/offramp/paycrest-directory.test.ts
git commit -m "feat(offramp): server-side Paycrest currency/institution/verify-account lookups"
```

---

## Task 5: `agent-resolver` — turn an LLM extraction into a verified order (or a question)

**Files:**
- Create: `src/lib/offramp/agent-resolver.ts`
- Create: `src/lib/offramp/agent-resolver.test.ts`

**Interfaces:**
- Consumes: `fetchCurrencies`, `fetchInstitutions`, `verifyAccount` (Task 4); `sourceChainOptions` (Task 2); `validateAmount`, `validateCurrency` from `@/lib/offramp/utils/validation`.
- Produces:
  ```typescript
  export interface AgentOrderExtraction {
    amount: string | null;
    token: string | null;
    sourceChain: string | null;
    destinationCurrency: string | null;
    institutionName: string | null;
    accountIdentifier: string | null;
  }

  export interface ResolvedAgentOrder {
    amount: string;
    token: string;
    sourceChain: OfframpSourceChainKey;
    beneficiary: {
      institution: string;      // Paycrest institution CODE, not the free-text name
      accountIdentifier: string;
      accountName: string;      // Paycrest-verified, never the LLM's guess
      currency: string;
      memo?: string;
    };
  }

  export type ResolveResult =
    | { status: "resolved"; order: ResolvedAgentOrder }
    | { status: "clarify"; message: string }
    | { status: "recap"; missing: string[] };

  export function classifyExtraction(extraction: AgentOrderExtraction): ResolveResult | { status: "complete" };
  export async function resolveAgentOrder(extraction: AgentOrderExtraction): Promise<ResolveResult>;
  ```
  (`classifyExtraction` is the synchronous, LLM-free "how many fields are missing" gate; `resolveAgentOrder` calls it first, then does the async bank/account/quote work only when it returns `"complete"`.)

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/offramp/agent-resolver.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyExtraction,
  resolveAgentOrder,
  type AgentOrderExtraction,
} from "./agent-resolver";

const COMPLETE: AgentOrderExtraction = {
  amount: "1000",
  token: "USDC",
  sourceChain: "base",
  destinationCurrency: "NGN",
  institutionName: "OPay",
  accountIdentifier: "0987654321",
};

test("classifyExtraction: fully populated is complete", () => {
  assert.equal(classifyExtraction(COMPLETE).status, "complete");
});

test("classifyExtraction: one missing field asks a targeted question, not a recap", () => {
  const result = classifyExtraction({ ...COMPLETE, accountIdentifier: null });
  assert.equal(result.status, "clarify");
  if (result.status === "clarify") {
    assert.match(result.message, /account number/i);
  }
});

test("classifyExtraction: two missing fields still asks (not a recap)", () => {
  const result = classifyExtraction({ ...COMPLETE, accountIdentifier: null, amount: null });
  assert.equal(result.status, "clarify");
});

test("classifyExtraction: three or more missing fields is a recap, not a question", () => {
  const result = classifyExtraction({
    ...COMPLETE,
    accountIdentifier: null,
    amount: null,
    sourceChain: null,
  });
  assert.equal(result.status, "recap");
  if (result.status === "recap") {
    assert.equal(result.missing.length, 3);
  }
});

function withFetch(impl: typeof globalThis.fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

test("resolveAgentOrder: happy path resolves with the verified name and real institution code", async () => {
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes("/currencies")) {
      return jsonResponse({ data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }] });
    }
    if (u.includes("/institutions/")) {
      return jsonResponse({ data: [{ code: "OPAYNGPC", name: "OPay" }, { code: "GTBNGPC", name: "GTBank" }] });
    }
    if (u.includes("/verify-account")) {
      return jsonResponse({ data: { accountName: "JOHN DOE" } });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }, async () => {
    const result = await resolveAgentOrder(COMPLETE);
    assert.equal(result.status, "resolved");
    if (result.status === "resolved") {
      assert.equal(result.order.beneficiary.institution, "OPAYNGPC");
      assert.equal(result.order.beneficiary.accountName, "JOHN DOE");
      assert.equal(result.order.beneficiary.currency, "NGN");
      assert.equal(result.order.sourceChain, "base");
    }
  });
});

test("resolveAgentOrder: unresolvable bank name asks which bank, not a guess", async () => {
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes("/currencies")) return jsonResponse({ data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }] });
    if (u.includes("/institutions/")) return jsonResponse({ data: [{ code: "GTBNGPC", name: "GTBank" }] });
    throw new Error(`unexpected fetch: ${u}`);
  }, async () => {
    const result = await resolveAgentOrder({ ...COMPLETE, institutionName: "SomeBankThatDoesNotExist" });
    assert.equal(result.status, "clarify");
    if (result.status === "clarify") assert.match(result.message, /bank/i);
  });
});

test("resolveAgentOrder: failed account verification asks to double check the number", async () => {
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes("/currencies")) return jsonResponse({ data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }] });
    if (u.includes("/institutions/")) return jsonResponse({ data: [{ code: "OPAYNGPC", name: "OPay" }] });
    if (u.includes("/verify-account")) return jsonResponse({}, false);
    throw new Error(`unexpected fetch: ${u}`);
  }, async () => {
    const result = await resolveAgentOrder(COMPLETE);
    assert.equal(result.status, "clarify");
    if (result.status === "clarify") assert.match(result.message, /account number/i);
  });
});

test("resolveAgentOrder: unsupported currency asks for a different one", async () => {
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes("/currencies")) return jsonResponse({ data: [{ code: "KES", name: "Kenyan Shilling", symbol: "KSh" }] });
    throw new Error(`unexpected fetch: ${u}`);
  }, async () => {
    const result = await resolveAgentOrder(COMPLETE);
    assert.equal(result.status, "clarify");
    if (result.status === "clarify") assert.match(result.message, /NGN|currency|support/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/agent-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/offramp/agent-resolver.ts
import { fetchCurrencies, fetchInstitutions, verifyAccount } from "./paycrest-directory";
import { sourceChainOptions, type OfframpSourceChainKey } from "./source-chain-options";
import { validateAmount } from "./utils/validation";

export interface AgentOrderExtraction {
  amount: string | null;
  token: string | null;
  sourceChain: string | null;
  destinationCurrency: string | null;
  institutionName: string | null;
  accountIdentifier: string | null;
}

export interface ResolvedAgentOrder {
  amount: string;
  token: string;
  sourceChain: OfframpSourceChainKey;
  beneficiary: {
    institution: string;
    accountIdentifier: string;
    accountName: string;
    currency: string;
    memo?: string;
  };
}

export type ResolveResult =
  | { status: "resolved"; order: ResolvedAgentOrder }
  | { status: "clarify"; message: string }
  | { status: "recap"; missing: string[] };

const FIELD_LABELS: Record<keyof AgentOrderExtraction, string> = {
  amount: "the amount",
  token: "which token",
  sourceChain: "which chain to send from",
  destinationCurrency: "the destination currency",
  institutionName: "the recipient's bank",
  accountIdentifier: "the account number",
};

function missingFields(extraction: AgentOrderExtraction): (keyof AgentOrderExtraction)[] {
  return (Object.keys(FIELD_LABELS) as (keyof AgentOrderExtraction)[]).filter(
    (key) => !extraction[key],
  );
}

/**
 * The ask-vs-reject threshold, kept deterministic and LLM-independent so
 * it's fully unit-testable: 1-2 missing fields gets a single targeted
 * question; 3+ gets one recap message listing everything still needed,
 * rather than an interrogation one field at a time.
 */
export function classifyExtraction(
  extraction: AgentOrderExtraction,
): { status: "complete" } | { status: "clarify"; message: string } | { status: "recap"; missing: string[] } {
  const missing = missingFields(extraction);
  if (missing.length === 0) return { status: "complete" };
  if (missing.length <= 2) {
    const labels = missing.map((key) => FIELD_LABELS[key]);
    return { status: "clarify", message: `What's ${labels.join(" and ")}?` };
  }
  return { status: "recap", missing: missing.map((key) => FIELD_LABELS[key]) };
}

/** Case-insensitive exact match first, then substring, else ambiguous/none. */
function matchInstitution(
  institutions: { code: string; name: string }[],
  freeText: string,
): { code: string } | "none" | "ambiguous" {
  const needle = freeText.trim().toLowerCase();
  const exact = institutions.filter((i) => i.name.toLowerCase() === needle);
  if (exact.length === 1) return { code: exact[0].code };
  const contains = institutions.filter(
    (i) => i.name.toLowerCase().includes(needle) || needle.includes(i.name.toLowerCase()),
  );
  if (contains.length === 1) return { code: contains[0].code };
  if (contains.length > 1) return "ambiguous";
  return "none";
}

export async function resolveAgentOrder(
  extraction: AgentOrderExtraction,
): Promise<ResolveResult> {
  const classified = classifyExtraction(extraction);
  if (classified.status !== "complete") return classified;

  // All six fields are non-null past this point (classifyExtraction gated it).
  const amount = extraction.amount!;
  const token = extraction.token!;
  const sourceChainRaw = extraction.sourceChain!;
  const currencyRaw = extraction.destinationCurrency!.toUpperCase();
  const institutionName = extraction.institutionName!;
  const accountIdentifier = extraction.accountIdentifier!;

  if (!validateAmount(amount)) {
    return { status: "clarify", message: "What amount would you like to offramp?" };
  }

  const enabledChains = sourceChainOptions();
  const chainMatch = enabledChains.find(
    (c) => c.code.toLowerCase() === sourceChainRaw.toLowerCase(),
  );
  if (!chainMatch) {
    const names = enabledChains.map((c) => c.name).join(", ");
    return {
      status: "clarify",
      message: `I can offramp from ${names} — which one did you mean?`,
    };
  }

  const currencies = await fetchCurrencies();
  const currencyMatch = currencies.find((c) => c.code.toUpperCase() === currencyRaw);
  if (!currencyMatch) {
    const supported = currencies.map((c) => c.code).join(", ") || "a supported currency";
    return {
      status: "clarify",
      message: `I can only pay out in ${supported} right now — which currency did you mean?`,
    };
  }

  const institutions = await fetchInstitutions(currencyMatch.code);
  const institutionMatch = matchInstitution(institutions, institutionName);
  if (institutionMatch === "none") {
    return {
      status: "clarify",
      message: `I couldn't find "${institutionName}" as a ${currencyMatch.code} bank — which bank did you mean?`,
    };
  }
  if (institutionMatch === "ambiguous") {
    return {
      status: "clarify",
      message: `A few banks match "${institutionName}" — can you give the exact bank name?`,
    };
  }

  const accountName = await verifyAccount(institutionMatch.code, accountIdentifier);
  if (!accountName) {
    return {
      status: "clarify",
      message: `I couldn't verify a ${institutionName} account at ${accountIdentifier} — please double check the account number.`,
    };
  }

  return {
    status: "resolved",
    order: {
      amount,
      token,
      sourceChain: chainMatch.code,
      beneficiary: {
        institution: institutionMatch.code,
        accountIdentifier,
        accountName,
        currency: currencyMatch.code,
      },
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/agent-resolver.test.ts`
Expected: PASS (9/9)

- [ ] **Step 5: Commit**

```bash
git add src/lib/offramp/agent-resolver.ts src/lib/offramp/agent-resolver.test.ts
git commit -m "feat(offramp): resolve an LLM order extraction against verified Paycrest data"
```

---

## Task 6: Add the AI SDK and Gateway config

**Files:**
- Modify: `package.json` (via `npm install`)
- Modify: `.env.example`

- [ ] **Step 1: Install dependencies**

Run: `npm install ai@^5 zod@^3`

- [ ] **Step 2: Document the new env var**

Add to `.env.example`, near the other third-party API sections:

```bash
# --- Agent Mode (natural-language offramp) ---
# Vercel AI Gateway — https://vercel.com/docs/ai-gateway. On a Vercel
# deployment this can be provided automatically via OIDC; set it explicitly
# for local dev. Get one from the Vercel dashboard -> AI Gateway.
AI_GATEWAY_API_KEY=your_ai_gateway_key_here
# Swappable without a code change. A small, fast model is enough for
# structured field extraction — no need for a frontier reasoning model here.
AGENT_PARSE_MODEL=anthropic/claude-haiku-4-5
```

- [ ] **Step 3: Verify install**

Run: `npx tsc --noEmit`
Expected: clean (nothing imports `ai`/`zod` yet, so this just confirms the install didn't break anything).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore(offramp): add AI SDK + zod for Agent Mode's structured parsing"
```

---

## Task 7: The parse route

**Files:**
- Create: `src/app/api/offramp/agent/parse/route.ts`

**Interfaces:**
- Consumes: `classifyExtraction`, `resolveAgentOrder`, `type AgentOrderExtraction` (Task 5), `sourceChainOptions` (Task 2), `fetchCurrencies` (Task 4, for the currency enum hint in the prompt).
- Produces: `POST` endpoint. Request body: `{ messages: { role: "user" | "agent"; content: string }[] }` (the conversation since the last resolved/abandoned order). Response body, one of:
  - `{ kind: "clarify"; message: string }`
  - `{ kind: "recap"; missing: string[] }`
  - `{ kind: "resolved"; order: ResolvedAgentOrder }`
  - `{ kind: "error"; message: string }` (HTTP 500, for a parse/LLM failure — never a raw stack trace)

- [ ] **Step 1: Write the route**

```typescript
// src/app/api/offramp/agent/parse/route.ts
import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { sourceChainOptions } from "@/lib/offramp/source-chain-options";
import { fetchCurrencies } from "@/lib/offramp/paycrest-directory";
import {
  classifyExtraction,
  resolveAgentOrder,
  type AgentOrderExtraction,
} from "@/lib/offramp/agent-resolver";

export const runtime = "nodejs";
export const maxDuration = 30;

const extractionSchema = z.object({
  amount: z.string().nullable().describe("The numeric USDC amount, as a plain string, e.g. \"1000\". Null if not stated."),
  token: z.string().nullable().describe("The token symbol, e.g. \"USDC\". Null if not stated — default to USDC if the user clearly means a stablecoin offramp but didn't name one."),
  sourceChain: z.string().nullable().describe("The lowercase chain key the user is sending from, matching one of the allowed values. Null if not stated or unclear."),
  destinationCurrency: z.string().nullable().describe("The 3-letter fiat currency code the recipient should be paid in, inferred from context (e.g. a Nigerian bank implies NGN) if not stated explicitly. Null only if truly unclear."),
  institutionName: z.string().nullable().describe("The recipient's bank or mobile-money provider, as free text exactly as the user wrote it (do not correct spelling). Null if not stated."),
  accountIdentifier: z.string().nullable().describe("The recipient's account number or phone number, digits only. Null if not stated."),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (messages.length === 0) {
      return NextResponse.json(
        { kind: "error", message: "No conversation to parse" },
        { status: 400 },
      );
    }

    const chains = sourceChainOptions().map((c) => c.code);
    const currencies = await fetchCurrencies();
    const currencyCodes = currencies.map((c) => c.code).join(", ");

    const { object: extraction } = await generateObject({
      model: process.env.AGENT_PARSE_MODEL || "anthropic/claude-haiku-4-5",
      schema: extractionSchema,
      system:
        `You extract offramp order details from a conversation between a user ` +
        `and Settu's offramp agent. The user wants to send crypto and have it ` +
        `paid out as fiat. Only use these source chains: ${chains.join(", ")}. ` +
        `Only use these destination currencies: ${currencyCodes}. ` +
        `Read the WHOLE conversation, not just the latest message — earlier ` +
        `turns may have already supplied fields the latest message doesn't ` +
        `repeat. Never invent a value that wasn't stated or clearly implied.`,
      messages: messages.map((m: { role: string; content: string }) => ({
        role: m.role === "agent" ? "assistant" : "user",
        content: m.content,
      })),
    });

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
    return NextResponse.json({ kind: "resolved", order: resolved.order });
  } catch (error: any) {
    return NextResponse.json(
      { kind: "error", message: "I had trouble understanding that — please try rephrasing." },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Verify it builds**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 3: Smoke test manually**

Run: `npm run dev`, then in another terminal (with `AI_GATEWAY_API_KEY` set in `.env.local`):

```bash
curl -sS -X POST http://localhost:3000/api/offramp/agent/parse \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Offramp 10 USDC on Base to my NGN OPay account 0987654321, John Doe"}]}'
```

Expected: a `{"kind":"resolved","order":{...}}` response (or `"clarify"` if the sandbox's OPay/NGN test data doesn't verify — either response shape confirms the route works end to end).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/offramp/agent/parse/route.ts
git commit -m "feat(offramp): Agent Mode parse route (LLM extraction + resolver)"
```

---

## Task 8: Wire `offrampInitiator` into `StellarampDashboard` (no UI yet)

**Why isolating this:** This is the one piece of `StellarampDashboard.tsx` that has to change to support Agent Mode at all — everything else is additive (new component, new tab). Landing it as its own reviewable step keeps the diff to the biggest, most sensitive file in the app small and easy to reason about before the new UI shows up.

**Files:**
- Modify: `src/components/StellarampDashboard.tsx`

**Interfaces:**
- Produces: `offrampInitiator: "form" | "agent"` state; `handleFormInitiateOfframp` (identical behavior to today's direct `handleExecuteTrade` wiring, plus tagging the run as `"form"`); `handleAgentInitiateOfframp` (same, tagged `"agent"`) — both with the exact same parameter type `handleExecuteTrade` already takes; `handleCancelOfframpFlow: () => void` (the modal's existing cancel-reset sequence, factored out so `AgentPanel` can trigger the same invalidation).

- [ ] **Step 1: Add the state and the two wrapper callbacks**

Find `const [mode, setMode] = useState<"offramp" | "onramp">("offramp");` (line ~379) and add directly after it:

```typescript
  // Which surface started the currently-running (or last-run) offramp —
  // decides whether TransactionProgressModal or AgentPanel narrates it.
  // handleExecuteTrade/EVM/Solana are unmodified; this only wraps the call.
  const [offrampInitiator, setOfframpInitiator] = useState<"form" | "agent">("form");
```

- [ ] **Step 2: Add the two wrapper functions**

Find the closing `};` of `handleExecuteTrade` (the top-level dispatcher — search for `const handleExecuteTrade = async (tradeData: {` and find its matching closing brace, before `/**\n   * Offramp from an EVM source chain.` which starts the next function). Directly after that closing `};`, add:

```typescript
  const handleFormInitiateOfframp = useCallback(
    (tradeData: Parameters<typeof handleExecuteTrade>[0]) => {
      setOfframpInitiator("form");
      return handleExecuteTrade(tradeData);
    },
    [handleExecuteTrade],
  );

  const handleAgentInitiateOfframp = useCallback(
    (tradeData: Parameters<typeof handleExecuteTrade>[0]) => {
      setOfframpInitiator("agent");
      return handleExecuteTrade(tradeData);
    },
    [handleExecuteTrade],
  );

  // Same invalidation the progress modal's own Cancel does (search for
  // `offrampFlowRef.current++` in this file to find it) — AgentPanel needs
  // an equivalent so its own "waiting on your wallet" message can offer a
  // way out, without needing the modal itself. Factored out here so both
  // callers share exactly one reset sequence.
  const handleCancelOfframpFlow = useCallback(() => {
    offrampFlowRef.current++;
    setShowProgressModal(false);
    setOfframpStep("idle");
    setOfframpError(null);
    setTradeState({});
    setIsExecutingOfframp(false);
    setCurrentTxId(null);
  }, []);
```

- [ ] **Step 3: Point `FormCard` at the form wrapper instead of `handleExecuteTrade` directly**

Change `onInitiateOfframp={handleExecuteTrade}` (in the `<FormCard ... />` JSX, around line 1999) to:

```typescript
                    onInitiateOfframp={handleFormInitiateOfframp}
```

- [ ] **Step 4: Gate `TransactionProgressModal` on the initiator, and reuse the new cancel function**

Change `<TransactionProgressModal isOpen={showProgressModal} ...>` to `isOpen={showProgressModal && offrampInitiator === "form"}`. Also replace its existing inline `onCancel={() => { offrampFlowRef.current++; ...six lines... }}` body with a call to the function from Step 2, so there's exactly one copy of that reset sequence:

```typescript
        onCancel={handleCancelOfframpFlow}
```

- [ ] **Step 5: Verify nothing regressed**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all clean. Then `npm run dev` and run through a normal offramp submission via the form — the progress modal should behave exactly as before (this task changes nothing observable yet; `offrampInitiator` just isn't read by anything except the modal's new gate, and the form always sets it to `"form"`). Also click Cancel mid-flow to confirm `handleCancelOfframpFlow` still resets exactly as the old inline version did.

- [ ] **Step 6: Commit**

```bash
git add src/components/StellarampDashboard.tsx
git commit -m "refactor(offramp): tag each offramp run with its initiator (form vs agent)"
```

---

## Task 9: `AgentPanel` component

**Files:**
- Create: `src/components/AgentPanel.tsx`

**Interfaces:**
- Consumes: `stepToAgentEvent`, `type AgentStepEvent` (Task 3); `type ResolvedAgentOrder` (Task 5, type-only import); `type OfframpStep` (from `@/components/TransactionProgressModal`); `handleCancelOfframpFlow` (Task 8, passed down as the `onCancelFlow` prop).
- Produces:
  ```typescript
  export interface AgentPanelProps {
    isConnected: boolean;
    isConnecting: boolean;
    onConnect: () => void;
    walletAddress?: string | null;
    sourceChainLabel: string;
    offrampStep: OfframpStep;
    offrampError: string | null;
    active: boolean; // true once this panel's own Confirm started the current run
    onCancelFlow: () => void; // same invalidation TransactionProgressModal's Cancel uses
    onInitiateOfframp: (tradeData: {
      amount: string;
      rate: number;
      token: string;
      sourceChain: ResolvedAgentOrder["sourceChain"];
      beneficiary: ResolvedAgentOrder["beneficiary"];
    }) => Promise<void> | void;
    onPricingUpdate: (data: {
      amount: string;
      quote: { destinationAmount: string; rate: number; currency: string; estimatedTimeMs: number } | null;
      isLoadingQuote: boolean;
      currency: string;
      gasFeeOptions: null;
    }) => void;
  }
  ```

- [ ] **Step 1: Write the component**

```tsx
// src/components/AgentPanel.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { stepToAgentEvent, type AgentStepEvent } from "@/lib/offramp/agent-step-bridge";
// Type-only import — erased at compile time, so this client component never
// pulls in the resolver's server-side fetch logic at runtime. Reusing the
// server's own type here (instead of hand-duplicating an equivalent shape)
// is what keeps the two from silently drifting apart.
import type { ResolvedAgentOrder } from "@/lib/offramp/agent-resolver";
import type { OfframpStep } from "@/components/TransactionProgressModal";

type ParseResponse =
  | { kind: "clarify"; message: string }
  | { kind: "recap"; missing: string[] }
  | { kind: "resolved"; order: ResolvedAgentOrder }
  | { kind: "error"; message: string };

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text?: string;
  order?: ResolvedAgentOrder; // present only on the confirmation-card message
  stepKind?: AgentStepEvent["kind"]; // present only on step-narration messages
}

let messageSeq = 0;
const nextId = () => `m${++messageSeq}`;

export interface AgentPanelProps {
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly onConnect: () => void;
  readonly sourceChainLabel: string;
  readonly offrampStep: OfframpStep;
  readonly offrampError: string | null;
  readonly active: boolean;
  readonly onCancelFlow: () => void;
  readonly onInitiateOfframp: (tradeData: {
    amount: string;
    rate: number;
    token: string;
    sourceChain: string;
    beneficiary: ResolvedAgentOrder["beneficiary"];
  }) => Promise<void> | void;
  readonly onPricingUpdate: (data: {
    amount: string;
    quote: { destinationAmount: string; rate: number; currency: string; estimatedTimeMs: number } | null;
    isLoadingQuote: boolean;
    currency: string;
    gasFeeOptions: null;
  }) => void;
}

/**
 * Natural-language front end for the offramp pipeline. Sits alongside
 * FormCard in the same grid slot (StellarampDashboard picks one or the
 * other based on `mode`). Confirming a resolved order calls the exact same
 * `handleExecuteTrade` dispatcher FormCard's button calls — this component
 * never signs or submits anything itself.
 */
export function AgentPanel({
  isConnected,
  isConnecting,
  onConnect,
  sourceChainLabel,
  offrampStep,
  offrampError,
  active,
  onCancelFlow,
  onInitiateOfframp,
  onPricingUpdate,
}: Readonly<AgentPanelProps>) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: nextId(),
      role: "agent",
      text: 'Tell me what you\'d like to offramp, e.g. "Offramp 500 USDC on Base to my GTBank account 0123456789, Jane Doe".',
    },
  ]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const lastRenderedStepId = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Mirrors TransactionProgressModal's own `canCancel` — only while waiting
  // on the wallet or the on-chain submit, and only for a run this panel
  // itself started.
  const canCancel =
    active && (offrampStep === "awaiting-signature" || offrampStep === "submitting");

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  // Narrate execution: every offrampStep change, while this panel owns the
  // current run, becomes one more chat message. Resets when a fresh run
  // starts (offrampStep returns to "idle").
  useEffect(() => {
    if (!active) return;
    if (offrampStep === "idle") {
      lastRenderedStepId.current = null;
      return;
    }
    const event = stepToAgentEvent(offrampStep, { sourceChainLabel, error: offrampError });
    if (!event || event.id === lastRenderedStepId.current) return;
    lastRenderedStepId.current = event.id;
    setMessages((prev) => [...prev, { id: nextId(), role: "agent", text: event.text, stepKind: event.kind }]);
  }, [active, offrampStep, offrampError, sourceChainLabel]);

  const conversationForOrder = (): { role: string; content: string }[] => {
    // Everything back to (and including) the last user/agent exchange that
    // hasn't yet produced a resolved order — a resolved-order card or a
    // completed run starts a fresh segment.
    const lastOrderIndex = [...messages].reverse().findIndex((m) => m.order);
    const startIndex = lastOrderIndex === -1 ? 0 : messages.length - lastOrderIndex;
    return messages
      .slice(startIndex)
      .filter((m) => m.text)
      .map((m) => ({ role: m.role, content: m.text! }));
  };

  const send = async () => {
    const text = input.trim();
    if (!text || isSending) return;
    setInput("");
    const userMessage: ChatMessage = { id: nextId(), role: "user", text };
    const history = [...conversationForOrder(), { role: "user", content: text }];
    setMessages((prev) => [...prev, userMessage]);
    setIsSending(true);
    try {
      const res = await fetch("/api/offramp/agent/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      const data: ParseResponse = await res.json();
      if (data.kind === "clarify") {
        setMessages((prev) => [...prev, { id: nextId(), role: "agent", text: data.message }]);
      } else if (data.kind === "recap") {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "agent", text: `I still need: ${data.missing.join(", ")}.` },
        ]);
      } else if (data.kind === "resolved") {
        setMessages((prev) => [...prev, { id: nextId(), role: "agent", order: data.order }]);
      } else {
        setMessages((prev) => [...prev, { id: nextId(), role: "agent", text: data.message }]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "agent", text: "I couldn't reach the server — please try again." },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  const confirmOrder = async (order: ResolvedAgentOrder) => {
    if (!isConnected) {
      onConnect();
      return;
    }
    setConfirming(true);
    try {
      // A live rate is required before handleExecuteTrade will run (same gate
      // FormCard's own quote effect satisfies) — Task 7's resolver already
      // confirmed the currency/institution/account; the rate for display and
      // for the Base-direct-transfer register payload still needs to be in
      // dashboard-level pricing state.
      const quoteRes = await fetch("/api/offramp/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: order.amount,
          amountIn: "crypto",
          token: order.token,
          currency: order.beneficiary.currency,
          network: "base",
        }),
      });
      const quotePayload = await quoteRes.json();
      if (!quoteRes.ok) {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "agent", text: `❌ ${quotePayload?.error || "Couldn't get a live rate — please try again."}` },
        ]);
        return;
      }
      onPricingUpdate({
        amount: order.amount,
        quote: {
          destinationAmount: quotePayload.destinationAmount,
          rate: quotePayload.rate,
          currency: order.beneficiary.currency,
          estimatedTimeMs: quotePayload.estimatedTime,
        },
        isLoadingQuote: false,
        currency: order.beneficiary.currency,
        gasFeeOptions: null,
      });
      await onInitiateOfframp({
        amount: order.amount,
        rate: quotePayload.rate,
        token: order.token,
        sourceChain: order.sourceChain,
        beneficiary: order.beneficiary,
      });
    } finally {
      setConfirming(false);
    }
  };

  return (
    <section className="flex flex-col gap-[1.1rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]">
      <div className="flex items-center justify-between border-b border-[var(--line)] pb-[0.6rem]">
        <h2 className="m-0 font-space-grotesk text-[1.1rem] font-bold">AGENT MODE</h2>
        <span className="text-[0.62rem] uppercase tracking-[0.1em] text-[var(--muted)]">Offramp</span>
      </div>

      <div ref={listRef} className="flex max-h-[420px] min-h-[300px] flex-col gap-[0.65rem] overflow-y-auto">
        {messages.map((m) => {
          if (m.order) {
            const o = m.order;
            return (
              <div key={m.id} className="flex justify-start">
                <div className="max-w-[92%] border border-[var(--line)] bg-[#101010] p-[0.8rem]">
                  <div className="mb-[0.55rem] text-[0.62rem] uppercase tracking-[0.1em] text-[var(--muted)]">
                    Offramp Summary
                  </div>
                  {[
                    ["Amount", `${o.amount} ${o.token}`],
                    ["Source", o.sourceChain],
                    ["Bank", o.beneficiary.institution],
                    ["Account", o.beneficiary.accountIdentifier],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between border-b border-dashed border-[#222] py-[0.22rem] text-[0.78rem]">
                      <span className="text-[var(--muted)]">{label}</span>
                      <span>{value}</span>
                    </div>
                  ))}
                  <div className="flex justify-between py-[0.22rem] text-[0.78rem]">
                    <span className="text-[var(--muted)]">Account name</span>
                    <span className="text-[var(--accent)]">{o.beneficiary.accountName} ✓ verified</span>
                  </div>
                  <div className="mt-[0.7rem] flex gap-[0.5rem]">
                    <button
                      type="button"
                      disabled={confirming}
                      onClick={() => confirmOrder(o)}
                      className="flex-1 bg-[var(--accent)] py-[0.55rem] text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[#0a0a0a] disabled:opacity-50"
                    >
                      {confirming ? "Working…" : isConnected ? "Confirm" : "Connect Wallet"}
                    </button>
                    <button
                      type="button"
                      disabled={confirming}
                      onClick={() =>
                        setMessages((prev) => [
                          ...prev,
                          { id: nextId(), role: "agent", text: "Cancelled — send a new message whenever you're ready." },
                        ])
                      }
                      className="flex-1 border border-[var(--line)] py-[0.55rem] text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[var(--muted)] disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            );
          }
          return (
            <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={
                  m.role === "user"
                    ? "max-w-[82%] bg-[var(--accent)] px-[0.75rem] py-[0.55rem] text-[0.82rem] font-medium text-[#0a0a0a]"
                    : `max-w-[82%] border border-[var(--line)] bg-[#141414] px-[0.75rem] py-[0.55rem] text-[0.82rem] ${
                        m.stepKind === "error" ? "text-red-400" : m.stepKind === "success" ? "text-[var(--accent)]" : ""
                      }`
                }
              >
                {m.text}
              </div>
            </div>
          );
        })}
      </div>

      {canCancel && (
        <button
          type="button"
          onClick={onCancelFlow}
          className="w-full py-[0.5rem] text-[0.7rem] font-bold uppercase tracking-[0.08em] text-[var(--muted)] hover:text-white"
        >
          Cancel
        </button>
      )}

      <div className="flex gap-[0.5rem] border-t border-[var(--line)] pt-[0.8rem]">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={isSending}
          placeholder="e.g. Offramp 500 USDC on Solana to my GTBank account…"
          className="h-[42px] flex-1 border border-[var(--line)] bg-[#0a0a0a] px-[0.7rem] text-[0.8rem] text-[var(--foreground)] outline-none placeholder:text-[#555]"
        />
        <button
          type="button"
          onClick={send}
          disabled={isSending || !input.trim()}
          className="bg-[var(--accent)] px-[1rem] text-[0.75rem] font-bold uppercase tracking-[0.05em] text-[#0a0a0a] disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Verify it builds**

Run: `npx tsc --noEmit`
Expected: clean. (Not wired into the dashboard yet — Task 10 does that — so there's no runtime check yet beyond typechecking.)

- [ ] **Step 3: Commit**

```bash
git add src/components/AgentPanel.tsx
git commit -m "feat(offramp): AgentPanel chat UI (not yet wired into the dashboard)"
```

---

## Task 10: Wrap `AgentPanel` in the racing-border treatment

**Why its own task:** `TransactionProgressModal.tsx` currently defines the racing-border CSS classes inline in `globals.css` (`.racing-border-wrapper` / `.racing-border-content`) as generically-named, reusable classes — confirm that and reuse them rather than redefining the animation a second time.

**Files:**
- Modify: `src/components/AgentPanel.tsx`

- [ ] **Step 1: Confirm the existing classes are generic, not modal-specific**

Run: `grep -n "racing-border" src/app/globals.css src/components/TransactionProgressModal.tsx`

Expected: `globals.css` defines `.racing-border-wrapper` / `.racing-border-content` at the top level (not scoped under a modal-specific parent selector), and `TransactionProgressModal.tsx` applies them as plain class names — confirming they're already reusable as-is.

- [ ] **Step 2: Wrap the panel's outer element**

In `src/components/AgentPanel.tsx`, change the returned JSX's outer element from:

```tsx
    <section className="flex flex-col gap-[1.1rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]">
```

to:

```tsx
    <div className="racing-border-wrapper">
      <section className="racing-border-content flex flex-col gap-[1.1rem] p-[1.2rem]">
```

(dropping the now-redundant `border border-[var(--line)] bg-[#0a0a0a]` — `.racing-border-content` already sets the background, and the animated border replaces the static one) — and close the new wrapping `<div>` after the existing `</section>`.

- [ ] **Step 3: Verify visually**

Run: `npm run dev`, temporarily render `<AgentPanel>` directly in place of `<FormCard>` in `StellarampDashboard.tsx` (or wait for Task 11, which wires it in properly) and confirm the gold conic-gradient border animates around the panel exactly as it does around `TransactionProgressModal`.

- [ ] **Step 4: Commit**

```bash
git add src/components/AgentPanel.tsx
git commit -m "style(offramp): racing-border treatment on AgentPanel, matching the progress modal"
```

---

## Task 11: Wire `AgentPanel` into `StellarampDashboard`

**Files:**
- Modify: `src/components/StellarampDashboard.tsx`

**Interfaces:**
- Consumes: `AgentPanel`, `AgentPanelProps` (Task 9/10); `offrampInitiator`, `handleAgentInitiateOfframp`, `handlePricingUpdate` (Task 8, already exists for pricing); `mode` state (widened here).

- [ ] **Step 1: Widen the `mode` type**

Change:

```typescript
  const [mode, setMode] = useState<"offramp" | "onramp">("offramp");
```

to:

```typescript
  const [mode, setMode] = useState<"offramp" | "onramp" | "agent">("offramp");
```

- [ ] **Step 2: Import `AgentPanel`**

Add near the other component imports (alongside the existing `FormCard` import):

```typescript
import { AgentPanel } from "@/components/AgentPanel";
```

- [ ] **Step 3: Add the third tab button**

Find the mode-switcher buttons (the `.map` over mode options that renders the Offramp/Onramp tab buttons — search for where `setMode(` is called for the existing two). Add a third button alongside them, following the exact same styling pattern as its siblings:

```tsx
              <button
                type="button"
                onClick={() => setMode("agent")}
                className={cn(
                  /* match the exact className expression the existing Offramp/Onramp
                     buttons use, substituting `mode === "agent"` for the active check */
                )}
              >
                Agent
              </button>
```

(Read the existing two buttons' exact JSX first — copy their className logic verbatim rather than inventing new styling, so the three tabs are visually identical apart from label and active state.)

- [ ] **Step 4: Render `AgentPanel` in `FormCard`'s grid slot when `mode === "agent"`**

The existing structure is:

```tsx
          {mode === "onramp" ? (
            <div className="grid grid-cols-[1fr_370px] gap-3 max-[1100px]:grid-cols-1">
              {/* OnrampPanel, PlatformStatsCard, RecentTransactionsTable */}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_370px] gap-3 max-[1100px]:grid-cols-1">
                <div className="max-[1100px]:order-1">
                  <FormCard ... />
                </div>
                <div className="row-span-2 col-start-2 ...">
                  <RightPanel ... />
                </div>
                <div className="col-start-1 ...">
                  <RecentTransactionsTable ... />
                </div>
              </div>
              <ProgressSteps ... />
            </>
          )}
```

Change the `<div className="max-[1100px]:order-1"><FormCard .../></div>` block to conditionally render `AgentPanel` instead when `mode === "agent"`, keeping `RightPanel`, `RecentTransactionsTable`, and `ProgressSteps` exactly as they are (both `"offramp"` and `"agent"` share this same branch — `mode === "onramp"` is the only other case):

```tsx
                <div className="max-[1100px]:order-1">
                  {mode === "agent" ? (
                    <AgentPanel
                      isConnected={uiIsConnected}
                      isConnecting={uiIsConnecting}
                      onConnect={handleConnect}
                      sourceChainLabel={activeSourceChainLabel}
                      offrampStep={offrampStep}
                      offrampError={offrampError}
                      active={offrampInitiator === "agent"}
                      onCancelFlow={handleCancelOfframpFlow}
                      onInitiateOfframp={handleAgentInitiateOfframp}
                      onPricingUpdate={handlePricingUpdate}
                    />
                  ) : (
                    <FormCard
                      isConnected={uiIsConnected}
                      isConnecting={uiIsConnecting}
                      isExecutingOfframp={isExecutingOfframp}
                      resetKey={formResetKey}
                      onConnect={handleConnect}
                      sourceChain={sourceChain}
                      onSourceChainChange={handleSourceChainChange}
                      walletAddress={activeUserAddress ?? null}
                      onInitiateOfframp={handleFormInitiateOfframp}
                      onPricingUpdate={handlePricingUpdate}
                      usdcBalance={
                        sourceChain === "stellar"
                          ? stellarUsdcBalanceRaw
                          : externalBalances
                            ? Number(externalBalances.usdc)
                            : null
                      }
                      isLoadingBalance={
                        sourceChain === "stellar"
                          ? isLoadingBalance
                          : externalWallet.isConnected && !externalBalances
                      }
                    />
                  )}
                </div>
```

The `mode === "onramp" ? ... : (...)` top-level branch stays a two-way branch — `"agent"` falls into the same `else` branch as `"offramp"` and is distinguished only inside the block above.

- [ ] **Step 5: Also show `TransactionProgressModal`'s progress steps section for agent mode**

`ProgressSteps` (rendered unconditionally in the non-onramp branch, below the grid) reads `isConnected`/`isConnecting` only — no change needed there; it already applies equally to Agent Mode.

- [ ] **Step 6: Verify end to end**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all clean.

Then `npm run dev`, click the new "Agent" tab, confirm:
- `FormCard` disappears, `AgentPanel` appears with the racing border, in the same column `FormCard` was in; `RightPanel`/`RecentTransactionsTable` stay where they are.
- Typing an offramp sentence and sending it produces either a clarifying question or the confirmation card (needs `AI_GATEWAY_API_KEY` set locally).
- Confirming with no wallet connected triggers the normal connect flow.
- Confirming with a wallet connected does **not** open `TransactionProgressModal` — narration happens as chat messages instead — and ends in a ✅ or ❌ message.
- While a run is at "Confirm the transaction in your wallet…" or "Submitting on…", a Cancel control appears below the message list; clicking it resets the flow (matches the form path's existing Cancel behavior — `handleCancelOfframpFlow` is the same reset either caller uses).
- Switching back to the "Offramp" tab and submitting the form still shows `TransactionProgressModal` exactly as before (this is the regression check for Task 8's gate).

**Known v1 limitation, not a bug:** switching away from the Agent tab and back unmounts and remounts `AgentPanel` (the `mode === "agent" ? <AgentPanel/> : <FormCard/>` conditional), so the conversation resets to the opening message. The spec left this open with a leaning toward persisting it; this plan intentionally ships the simpler version first (no state lifted to the dashboard, no hidden-not-unmounted panel) since nothing else in this plan depends on the answer. Revisit only if it turns out to matter in practice — lifting `messages`/`input` state up into `StellarampDashboard` and passing them down as props is the straightforward follow-up if so.

- [ ] **Step 7: Commit**

```bash
git add src/components/StellarampDashboard.tsx
git commit -m "feat(offramp): wire AgentPanel into the dashboard as a third mode"
```

---

## Task 12: Rate-limit the parse route

**Files:**
- Create: `src/lib/offramp/agent-rate-limit.ts`
- Create: `src/lib/offramp/agent-rate-limit.test.ts`
- Modify: `src/app/api/offramp/agent/parse/route.ts`

**Interfaces:**
- Produces: `checkAgentRateLimit(key: string): boolean` — `true` if the call is allowed, `false` if the key has exceeded the window. In-memory (module-level `Map`), matching this project's convention of using Upstash Redis only for state that must survive across serverless instances/deploys — a short-window abuse guard on one route doesn't need that durability.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/offramp/agent-rate-limit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { checkAgentRateLimit, _resetForTests } from "./agent-rate-limit";

test("allows calls under the limit", () => {
  _resetForTests();
  for (let i = 0; i < 10; i++) {
    assert.equal(checkAgentRateLimit("wallet-a"), true);
  }
});

test("blocks the call once the limit is exceeded within the window", () => {
  _resetForTests();
  for (let i = 0; i < 10; i++) checkAgentRateLimit("wallet-b");
  assert.equal(checkAgentRateLimit("wallet-b"), false);
});

test("different keys are independent", () => {
  _resetForTests();
  for (let i = 0; i < 10; i++) checkAgentRateLimit("wallet-c");
  assert.equal(checkAgentRateLimit("wallet-c"), false);
  assert.equal(checkAgentRateLimit("wallet-d"), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/agent-rate-limit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/offramp/agent-rate-limit.ts
// A stray loop or a bored visitor shouldn't be able to run up LLM cost on
// this one route. In-memory is fine here: each serverless instance gets its
// own generous budget, and the failure mode of "resets on redeploy/cold
// start" is harmless for an abuse guard (unlike payout/ledger state, which
// uses Upstash Redis elsewhere in this codebase because it must survive
// exactly that).
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;

let hits = new Map<string, number[]>();

export function checkAgentRateLimit(key: string): boolean {
  const now = Date.now();
  const timestamps = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (timestamps.length >= MAX_PER_WINDOW) {
    hits.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  hits.set(key, timestamps);
  return true;
}

export function _resetForTests(): void {
  hits = new Map();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/agent-rate-limit.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Wire it into the parse route**

In `src/app/api/offramp/agent/parse/route.ts`, add the import:

```typescript
import { checkAgentRateLimit } from "@/lib/offramp/agent-rate-limit";
```

and at the top of the `try` block, right after parsing `body`:

```typescript
    const clientKey =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!checkAgentRateLimit(clientKey)) {
      return NextResponse.json(
        { kind: "error", message: "Too many messages — please wait a moment and try again." },
        { status: 429 },
      );
    }
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/offramp/agent-rate-limit.ts src/lib/offramp/agent-rate-limit.test.ts src/app/api/offramp/agent/parse/route.ts
git commit -m "feat(offramp): rate-limit the Agent Mode parse route"
```

---

## Final verification

- [ ] Run the full suite once more end to end: `npx tsc --noEmit && npm test && npm run build`
- [ ] Manual smoke test on a real device/browser per Task 11 Step 6, plus: an amount below the corridor minimum, a bank name that doesn't exist, an account number that fails verification, and a sentence missing 3+ fields (recap path) — confirm each produces the right kind of chat response.
- [ ] Confirm the Offramp tab (form path) still shows `TransactionProgressModal` and completes a trade exactly as before this plan started — this is the regression check that matters most, since `handleExecuteTrade` et al. were never meant to change behavior.
