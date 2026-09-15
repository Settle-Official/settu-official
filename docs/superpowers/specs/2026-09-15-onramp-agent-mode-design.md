# Onramp support in Agent Mode

## Context

Agent Mode (`AgentPanel.tsx`) currently only handles offramp (crypto → fiat)
requests, extracted and resolved by `agent-resolver.ts` and executed through
the same `handleExecuteTrade` dispatcher FormCard uses. This spec adds onramp
(fiat → crypto) support to the same chat interface, so a user can type
something like "I want to buy 50000 NGN worth of USDC into my Stellar wallet"
and get the same natural-language experience offramp already has.

A prerequisite investigation (recorded in conversation, not a separate doc)
confirmed the onramp Base→Stellar bridge leg already runs on direct Circle
CCTP, not Allbridge — that migration happened in August
(`2026-08-20-cctp-direct-integration-design.md`). No bridge-infrastructure
work is needed here; this spec is purely about exposing the existing,
already-CCTP-backed onramp flow through Agent Mode.

## Why onramp doesn't fit the existing offramp card pattern

Offramp's confirmation card works because a quote (rate + destination amount)
is fetched *before* the card is shown, and confirming triggers the user's
wallet to sign a transaction. Onramp has neither:

- Paycrest doesn't return a rate until the order is actually created —
  `OnrampPanel.tsx` shows no pre-order quote either, only the fiat amount the
  user is typing.
- There is no wallet-signing step at all. The user pays a bank account
  outside the app; the platform's custodial hot wallet and the CCTP pipeline
  handle everything on-chain, autonomously, once the fiat settles.

So confirming an onramp order means "create the order," not "here's the
locked numbers, sign this." The exact amount-to-transfer and rate only
appear in the message that follows confirmation, once Paycrest responds.

## Decisions (from user Q&A)

- **Destination Stellar address**: always asked for explicitly in the
  conversation. Agent Mode does not default to the connected wallet, even if
  one is connected — matches OnrampPanel's own "custom address" option, and
  keeps onramp in Agent Mode usable with zero wallet connection.
- **Refund bank account**: required upfront, resolved with the same rigor as
  offramp's beneficiary (bank name matched via `matchInstitution`, including
  the nickname-alias fallback; account verified via `verifyAccount`).
- **Confirmation step**: yes, shown before the order is created, even though
  nothing irreversible happens until the user actually pays — consistent
  with offramp's pattern and gives the user a chance to catch a typo before
  an order (and its ~1h Paycrest expiry clock) exists.
- **Intent detection**: automatic. One extraction call classifies the
  message as onramp or offramp; the user never has to say a magic word.
- **Post-confirmation behavior**: show the virtual account details as a
  card, then narrate live status updates in chat as the order progresses
  (deposited → bridging → delivered), the same way offramp narrates
  execution steps.

## Architecture

### 1. Unified parse route, direction-branched

`/api/offramp/agent/parse/route.ts`'s extraction schema gains a `direction`
field and the onramp-specific fields, all nullable like the existing ones:

```ts
const extractionSchema = z.object({
  direction: z.enum(["onramp", "offramp"]).nullable()
    .describe("Whether the user wants to convert fiat to crypto (onramp) or crypto to fiat (offramp). Null if genuinely ambiguous."),
  // existing offramp fields, unchanged
  amount, token, sourceChain, destinationCurrency, institutionName, accountIdentifier,
  // new onramp fields
  fiatAmount: z.string().nullable().describe("The fiat amount to convert to crypto, as a plain string. Null if not stated."),
  fiatCurrency: z.string().nullable().describe("The 3-letter fiat currency code being paid in. Null if not stated or unclear."),
  destinationStellarAddress: z.string().nullable().describe("The Stellar G... address to receive USDC. Null if not stated."),
  refundInstitutionName: z.string().nullable().describe("The bank the user wants a refund sent to if the fiat payment can't be matched, as free text exactly as written. Null if not stated."),
  refundAccountIdentifier: z.string().nullable().describe("The refund bank account number, digits only. Null if not stated."),
});
```

One LLM call, one system-prompt addition explaining both directions exist.
After extraction, `typedExtraction.direction` (falling back to a cheap
heuristic — presence of onramp-only fields — if the model left it null)
branches into the existing offramp logic or the new onramp logic below. A
`direction` mismatch discovered mid-conversation (rare — e.g. user starts
describing offramp then pivots) is handled the same way a resolver
"clarify" is today: no special-casing needed, since `conversationForOrder`
already re-sends full history each turn and a fresh extraction naturally
picks up the correction.

### 2. New resolver: `src/lib/offramp/agent-onramp-resolver.ts`

Mirrors `agent-resolver.ts`'s shape exactly:

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
  refundAccount: {
    institution: string;   // Paycrest institution code
    accountIdentifier: string;
    accountName: string;   // verified
    currency: string;
  };
}

export type OnrampResolveResult =
  | { status: "resolved"; order: ResolvedOnrampOrder }
  | { status: "clarify"; message: string }
  | { status: "recap"; missing: string[] };

export function classifyOnrampExtraction(extraction: OnrampAgentExtraction): ...
export async function resolveOnrampOrder(extraction: OnrampAgentExtraction): Promise<OnrampResolveResult>
```

`classifyOnrampExtraction` reuses the identical 0 / 1-2 / 3+ missing-field
threshold logic as offramp's `classifyExtraction` (single question vs. one
recap). `resolveOnrampOrder`:

1. `validateAmount(fiatAmount)` → clarify on failure.
2. `validateAddress(destinationStellarAddress, "stellar")` → clarify on
   failure ("That doesn't look like a valid Stellar address...").
3. `fetchCurrencies()` → confirm `fiatCurrency` is supported → clarify with
   the supported list otherwise (same pattern as offramp's currency check).
4. `fetchInstitutions(currency)` + `matchInstitution(institutions, refundInstitutionName)`
   — **the exact same function offramp uses**, so GTBank/UBA/9PSB nickname
   resolution works for the refund bank for free. Same
   none/ambiguous/resolved clarify messages.
5. `verifyAccount(institutionCode, refundAccountIdentifier)` → clarify
   ("couldn't verify a ... account at ...") on failure, same as offramp.
6. Return `resolved` with the fully-verified order. No quote fetch — there
   is none to get yet.

`matchInstitution` is currently private to `agent-resolver.ts`; it is
exported from there (no logic change) so both resolvers import the same
implementation instead of duplicating it.

### 3. Shared client-side order creation: `src/lib/onramp/client.ts`

Extracts `OnrampPanel.tsx`'s existing `handleSubmit` fetch body verbatim
into a plain function:

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
// throws with the server's error message on failure — same contract
// OnrampPanel's try/catch already assumes.
```

`OnrampPanel.tsx`'s `handleSubmit` is updated to call this instead of
inlining the fetch — pure refactor, no behavior change, removes the only
duplication risk between the two callers.

### 4. Shared status copy: `src/lib/onramp/status-labels.ts`

`OnrampPanel.tsx`'s existing `STATUS_LABEL` map moves here verbatim and is
imported back into `OnrampPanel.tsx`. `agent-onramp-step-bridge.ts` (next
section) imports the same map so the chat narration uses identical wording
to the existing UI — no invented copy, no drift risk between the two
surfaces.

### 5. New step bridge: `src/lib/offramp/agent-onramp-step-bridge.ts`

Pure function, parallel to `agent-step-bridge.ts`:

```ts
export interface OnrampStepEvent { id: string; kind: "progress" | "success" | "error"; text: string; }

export function onrampStatusToAgentEvent(
  status: string,
  opts: { stellarTxHash?: string },
): OnrampStepEvent | null
```

Maps each `OnrampRecord` status to a chat line using `STATUS_LABEL` as the
base text, with two enrichments:

- `delivered` → success kind, text includes a shortened `stellarTxHash`.
- `bridge_failed` → error kind (but see "never closes the stream" below).

`refunding`/`refunded`/`expired` → straightforward progress/error mapping,
same copy as `STATUS_LABEL`.

### 6. `AgentPanel.tsx` changes

`ChatMessage` gains two new optional fields, following the exact pattern
`order`/`orderStatus` already use:

```ts
onrampOrder?: ResolvedOnrampOrder;         // present only on the onramp confirmation-card message
onrampOrderStatus?: "confirmed" | "success" | "failed" | "cancelled";
virtualAccount?: { orderId: string; account: OnrampProviderAccount };  // present only on the post-confirm account-details message
```

New props on `AgentPanelProps`:

```ts
onInitiateOnramp: (order: ResolvedOnrampOrder) => Promise<CreateOnrampOrderResult>;
```

(No `onConnect`/`isConnected` gate needed for onramp — confirmed by the
"always ask for the address explicitly" decision.)

`send()` handles a new `ParseResponse` variant, `{ kind: "resolved-onramp"; order: ResolvedOnrampOrder }`,
alongside the existing `resolved` (offramp) — pushes a message with
`onrampOrder` set, parallel to how `resolved` pushes one with `order` set.

New `confirmOnrampOrder(order)`:

1. Marks the card `onrampOrderStatus: "confirmed"` immediately (same
   pattern as `confirmOrder`, hides Confirm/Cancel right away).
2. Calls `onInitiateOnramp(order)`.
3. On success: marks the card `"success"`, pushes a new message with
   `virtualAccount` set (bank/account/amount/expiry from
   `providerAccount`), and opens `new EventSource('/api/onramp/stream/' + id)`.
   The stream's `onmessage` runs each status through
   `onrampStatusToAgentEvent` and appends a chat message exactly like the
   existing offramp step-narration effect does, closing the `EventSource`
   on `delivered`/`refunded`/`expired` (matching the stream's own terminal
   behavior — it doesn't close itself on `bridge_failed`, so neither does
   this).
4. On failure (order creation itself, e.g. Paycrest 5xx or a validation
   error the resolver couldn't catch): clears `onrampOrderStatus` back to
   **undefined** (not `"failed"`) so Confirm/Cancel reappear, and posts the
   error message returned by `createOnrampOrder`. This is the one place
   onramp's card lifecycle differs from offramp's: offramp's `"failed"`
   means a trade ran and lost; onramp's pre-creation failure means nothing
   happened yet, so retry should stay available on the same card rather
   than presenting a dead-end "Failed" card.

Rendering: the onramp confirmation card is a new block (parallel to the
existing `m.order` block) triggered by `m.onrampOrder`, showing amount /
currency / destination address / refund bank / refund account name, with
Confirm/Cancel gated on `!m.onrampOrderStatus` exactly like the offramp
card. The virtual-account card (`m.virtualAccount`) is a simpler
display-only block: bank name, account number (with a copy affordance,
matching `VirtualAccountView`'s existing UX intent), exact amount, currency,
expiry — no buttons.

### 7. `StellarampDashboard.tsx` changes

Passes a new `onInitiateOnramp={createOnrampOrder}` prop (the shared
client helper from `src/lib/onramp/client.ts`, imported directly — no
StellarampDashboard-level wrapping needed, since onramp order creation
doesn't touch any of the wallet/offramp-execution state this component
otherwise manages).

## Data flow (happy path)

1. User: "I want to buy 100000 NGN of USDC, send it to GABC...XYZ, refund to my GTBank account 0123456789 Jane Doe."
2. Parse route extracts `direction: "onramp"` + all fields populated in one shot → `resolveOnrampOrder` validates amount, currency, Stellar address, resolves "GTBank" via the alias table, verifies the account → `resolved-onramp`.
3. AgentPanel shows the onramp confirmation card.
4. User clicks Confirm → `confirmOnrampOrder` → `createOnrampOrder()` → Paycrest order created → virtual-account card appears + SSE opens.
5. Chat narrates: "Waiting for your bank transfer…" → (user pays externally) → "Fiat received — confirming…" → "Payment confirmed by provider…" → "Releasing USDC on Base…" → "USDC received — bridging to Stellar…" → "Bridging to your Stellar wallet…" → "Delivered to your Stellar wallet ✓ (tx abc123...)".

## Error handling

- Missing/invalid fields: same clarify (1-2 missing) / recap (3+ missing) split as offramp, reusing `classifyOnrampExtraction`.
- Invalid Stellar address, unsupported currency, unmatched/ambiguous bank, failed account verification: same clarify-message shapes as offramp's resolver, worded for the onramp context.
- Order-creation failure: card stays confirmable (see above), error posted as a chat message — never a dead end.
- `bridge_failed` mid-flow: narrated as "held for review, team alerted" (existing copy), stream stays open since the platform's hold-and-alert policy means a human may still resolve it forward.
- Rate limiting: reuses the existing `checkAgentRateLimit` already wrapping the parse route — no change needed, one shared budget across both directions.

## Testing

- `agent-onramp-resolver.test.ts`: unit tests mirroring `agent-resolver.test.ts` exactly — classify thresholds, happy-path resolve, invalid Stellar address, unsupported currency, unresolvable/ambiguous bank name (including a nickname-alias case, reusing the existing `institution-aliases.ts` fixtures), failed account verification. All via mocked `fetch`, no live network calls, matching the existing test's pattern.
- `agent-onramp-step-bridge.test.ts`: pure mapping tests, one per status, mirroring `agent-step-bridge.test.ts`.
- No new tests needed for `matchInstitution`'s export change (pure visibility change, existing tests already cover its behavior via `resolveAgentOrder`).
- Manual/live verification: send an onramp message through Agent Mode in the browser, confirm the card renders, confirm order creation returns a real Paycrest virtual account, confirm the SSE narration appends messages (can be verified without actually paying, by watching the `pending` status narrate correctly and the stream stay open).

## Out of scope

- Any change to the CCTP bridge mechanics themselves (already correct, per the recap).
- Cleaning up the legacy Allbridge onramp code paths (`allbridge-adapter.ts`, `finalize.ts`'s Allbridge branch) — explicitly deferred by the user in favor of this feature.
- A rate/quote preview before order creation — Paycrest's API doesn't support this for onramp today; showing one would require product/API changes beyond this feature's scope.
