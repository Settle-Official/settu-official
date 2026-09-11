# Offramp Agent Mode — Design Spec

Status: approved by user (chat + visual mockup), 2026-09-12. Ready for implementation planning.

## Context

Paycrest published a "Sender Agent" — an MCP server (`paycrest/sender-mcp`) that lets a developer using an MCP-capable client (Claude Code, Cursor, VS Code) create and track Paycrest orders with natural language, e.g. *"offramp 0.5 USDC Base, refund 0x0c89…, NGN OPay 0987654321, John Doe."* The idea for Settu: give end users an equivalent experience — an "Agent" tab where they type a sentence and the offramp happens, with the agent narrating progress.

### Why Settu does not depend on the Paycrest MCP server itself

The MCP binary is designed for **one developer/operator running one local stdio process** configured with one `PAYCREST_API_KEY` in one MCP client's config file. It has no per-end-user auth model, no HTTP surface, and no concurrency story for many simultaneous end users. Its own flow is explicitly human-in-the-loop and manual: the agent creates an order and shows pay-in details, then *the human* sends funds themselves outside the agent and types "paid." It doesn't hold a wallet or move funds — it's a conversational wrapper around the same Paycrest Sender API Settu already calls directly via `PaycrestAdapter`.

Settu already has everything the MCP wraps, and more robustly (order creation, live-status reconciliation, webhook handling, the stranded-burn backstop from PR #42). What Settu is missing is only the **front door**: turning a free-text sentence into the same structured fields `FormCard` already collects. That's the actual scope of this feature — a natural-language input surface in front of the existing, already-hardened offramp pipeline. Nothing about CCTP burns, Paycrest order creation, or status polling changes.

### Hard constraints

- **Non-custodial stays non-custodial.** The user's own connected wallet signs the on-chain leg, exactly as today. An LLM cannot move funds on the user's behalf — there is always at least one wallet-approval step. Product copy must not imply "type a sentence and it's fully done" — it's "type a sentence, review, approve in your wallet."
- **Never execute from a raw LLM parse.** Amounts and account numbers are exactly the kind of thing a misparse turns into a real loss. Structured output from the LLM is always run through the same resolution/verification Settu already performs (bank match, account-name verification, live quote) before the user ever sees a "Confirm" button, and confirming only ever calls the same execution functions the form's Confirm button calls.

## Scope (v1)

- **Offramp only.** Onramp (fiat → crypto) is out of scope for this version.
- **Every offramp source chain the form already supports** (Stellar, EVM chains, Solana) is fair game — the example prompt ("Offramp 1,000 USDC on Base…") is an EVM chain, not Stellar-only.
- Agent Mode **sits alongside** the existing form as a third mode, not a replacement.

## UI

### Placement

`StellarampDashboard`'s `mode` state (`useState<"offramp" | "onramp">`) gains a third value, `"agent"`. A third tab/button next to Onramp/Offramp. Selecting it behaves like `"offramp"` for every derived flag that already exists (`isSolanaSource`, `isEvmSource`, wallet state, `activeSourceChainLabel`, etc.) — it only changes which component renders in `FormCard`'s grid slot (the fluid `1fr` column). `RightPanel` keeps its fixed 370px column and `RecentTransactionsTable` stays below, both untouched — confirmed at real page proportions in the visual mockup, not just in isolation.

### Chat panel visual design (confirmed via mockup)

- The whole panel is wrapped in the same conic-gradient "racing border" animation `TransactionProgressModal` already uses (`.racing-border-wrapper` / `.racing-border-content` pattern, or a shared extraction of it — see Components).
- User messages: gold background (`--accent` / `#c9a962`), black text, right-aligned.
- Agent messages: dark background, white text, `1px solid var(--line)` border, left-aligned.
- Square corners throughout — no `border-radius` anywhere, matching the rest of the app (no rounding exists in `TransactionProgressModal`, `SelectField`, `EvmConnectModal`, etc.).
- The confirmation "order summary" card is a bordered box (not a chat bubble) with a small-caps label, key/value rows (amount, source chain, bank, account number, **verified** account name shown in accent gold, rate, estimated payout), and two buttons: solid-gold "Confirm" / outlined-muted "Cancel."
- Status narration after Confirm renders as short lines with a check (✓, accent gold) for completed steps and the existing bouncing-dot treatment (already in `globals.css` as `dot-bounce`) for the in-progress one, ending in a single ✅/❌ summary line.
- Message list scrolls internally within a bounded-height panel (not an ever-growing page); input bar pinned to the bottom.

### App-wide scrollbar theme

Not specific to Agent Mode, but decided during this design pass: add a custom scrollbar treatment to `globals.css` used by every scrollable area in the app — black track, gold (`--accent`) thumb lightening to `--accent-light`/`#f4e1ad` on hover, thin, square corners (`scrollbar-color`/`scrollbar-width` for Firefox, `::-webkit-scrollbar*` for Chromium/Safari). Ship this as part of the same work, since Agent Mode's message list is the first place that needed a real scrollbar.

## Components

New:
- **`AgentPanel`** (`src/components/AgentPanel.tsx`) — the chat UI: message list, input box, renders user/agent bubbles and the order-summary card inline. Owns conversation history and "pending order" slot-filling state as local React state (not persisted server-side — same spirit as `TransactionStorage` being client-local). Resets pending-order state once an order reaches a terminal state or the user clearly starts a new request.
- **Agent parse route** (`src/app/api/offramp/agent/parse/route.ts`) — server-side. Takes the latest user message + conversation-so-far, calls an LLM via the Vercel AI SDK against the AI Gateway with a structured-output/tool-call schema matching the order shape (`sourceChain`, `amount`, `token`, `destinationCurrency`, `institution` (free-text as given), `accountIdentifier`, `accountName`). Returns one of: **clarifying question** (1–2 fields missing/ambiguous), **recap** (too sparse — lists everything still needed in one message), or **structurally complete** (hands off to the resolver below). Model choice is an implementation-time detail — the smallest model that reliably follows the schema, selected via the Gateway's plain `"provider/model"` string convention.
- **`agent-resolver`** (`src/lib/offramp/agent-resolver.ts`) — takes a structurally-complete parse and does what `FormCard`'s effects already do reactively, but as one resolution pass: fuzzy-match the free-text bank name against the real institution list for that currency, verify the account number (get the real, verified account name back), pull a live quote. Returns **resolved** (verified data, ready for the confirmation card) or **needs-info** (resolution failed on a specific field — becomes the next clarifying question, e.g. "I couldn't verify an OPay account at that number"). Deliberately does **not** duplicate the balance-sufficiency check — that already happens cleanly inside `handleExecuteTrade` et al. and throws a clear error; re-implementing it here would just be two places that can disagree.
- **`agent-step-bridge`** (`src/lib/offramp/agent-step-bridge.ts`) — a small, pure-ish piece that watches `offrampStep` / `tradeState` / `offrampError` (the same state `TransactionProgressModal` already renders) and produces a sequence of chat-message events instead. `handleExecuteTrade` / `handleExecuteEvmTrade` / `handleExecuteSolanaTrade` are **not modified** — this is purely an alternate consumer of their existing output.

Reused as-is: `handleExecuteTrade`/`handleExecuteEvmTrade`/`handleExecuteSolanaTrade` (chosen by parsed `sourceChain`, same dispatch the form already does), the Paycrest institutions/verify-account/quote calls `FormCard` already makes, `offrampFlowRef` cancellation (PR #46) for the chat's own Cancel affordance.

Modified: `StellarampDashboard.tsx` (third `mode` value + render `AgentPanel` in the grid slot), `globals.css` (scrollbar theme).

## Data flow

1. User types a sentence in `AgentPanel`.
2. `AgentPanel` posts it + conversation history to the parse route.
3. Parse route runs the LLM call, returns a clarifying question / recap / structurally-complete parse.
4. If structurally complete, `agent-resolver` runs (can be the same route or a second call) and returns resolved-with-verified-data or needs-info.
5. `AgentPanel` renders the outcome: another agent chat bubble (question or recap), or the order-summary card.
6. User taps Confirm on the card → `AgentPanel` calls the same `handleExecute*Trade` function the form uses, with the resolved data.
7. From here, execution proceeds completely unchanged (wallet connect if needed → sign → submit → register → poll). `agent-step-bridge` turns each `offrampStep` transition into a chat message instead of a modal step, ending in one final success/failure line reusing `offrampError` verbatim on failure.
8. The conversation stays open — a new message starts a new order in the same thread.

## Error handling & safety rails

- Resolver failures become targeted clarifying questions, never a guessed confirmation card.
- Execution failures reuse the exact `offrampError` string the modal would have shown — no new error copy to maintain.
- The "waiting on your wallet" / "submitting" chat message carries a Cancel control wired to the same `offrampFlowRef` invalidation the modal's Cancel button uses (PR #46), so a stale signature rejection can't corrupt a conversation that's moved on.
- Simple LLM-call abuse/cost guard (e.g. a per-session message cap or short per-wallet cooldown) — not elaborate, just enough that a stray loop or a bored visitor can't run up API cost.

## Testing

- `agent-resolver`'s fuzzy bank-matching and missing-field detection: unit-testable against fixtures, same style as this codebase's existing `*.test.ts` files.
- `agent-step-bridge`: given a sequence of `offrampStep`/`tradeState` values, assert the produced message sequence — no LLM involved, fully deterministic.
- The LLM parse itself is not unit-tested in the traditional sense: a small fixed set of example prompts (including Paycrest's own two examples) checked via a smoke script, the way the WalletConnect and CCTP integrations were smoke-tested earlier in this project.

## Open items for the implementation plan

- Exact request/response schema for the parse route (tool-call shape).
- Which model string to use behind the AI Gateway.
- Exact shape of the LLM-call rate limit (per-session vs per-wallet, what window).
- Whether `AgentPanel`'s conversation should survive a `mode` tab-switch away and back within the same page load (leaning yes — same page, same component tree, just hidden), to be confirmed during implementation.
