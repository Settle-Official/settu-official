# Agent conversation persistence

Status: **spec**. Option 1 (in-memory, layout-scoped) is built and shipped;
this describes the durable layer that replaces it, to be implemented once
accounts land.

## The problem, stated precisely

Two things used to be lost when the user tapped another tab, and they need
different treatments:

1. **The conversation** — `messages` in `AgentPanel`. Pure client state.
   Nothing else in the system knows it exists.
2. **The in-flight run** — `offrampStep`, the confirmed order, the
   initiator. Also client state, but the server is already authoritative
   about all of it, and exposes it at `/api/offramp/stream/[orderId]` and
   `/api/onramp/stream/[orderId]`.

Only (1) needs storing. Persisting (2) would create a second copy of
something the server already owns, and the two would disagree the first
time a tab slept through a settlement. (2) is fixed by re-subscribing to
the existing stream on mount — **not yet done**, see Open work.

## What is built today (Option 1)

`src/components/app/AgentConversation.tsx` — a provider mounted in
`src/app/app/layout.tsx`, alongside `WalletBarProvider`,
`AgentUnreadProvider`, `NotificationsProvider` and `ScreenBackProvider`.
The layout does not unmount on a route change, so the thread survives tab
switching.

It holds `messages`, `readCount` (the unread marker indexes into the same
array, so the two belong together) and `lastCompletedOrder` (what "do that
again" repeats). `AgentPanel` reads all of it from context and owns none of
it.

Limits: memory only. A reload, a closed tab, or a second device all start
fresh.

## Option 3 — server-side, keyed by the user

### Why keyed by user, not by wallet

A wallet address is the only identifier available today, but a signed-in
user will have several — an embedded wallet plus whatever they connect —
and will expect one conversation across devices. Keying on address now
means re-keying every record later.

So the store takes a **`subjectId`**: the wallet address until accounts
land, the account id afterwards. That single value is the whole migration.

### The seam

```ts
export interface ConversationStore {
  load(subjectId: string): Promise<ChatMessage[]>;
  append(subjectId: string, message: ChatMessage): Promise<void>;
  replace(subjectId: string, messages: ChatMessage[]): Promise<void>;
  clear(subjectId: string): Promise<void>;
}
```

Three implementations behind one interface, chosen by config:

- `MemoryConversationStore` — what the provider does today. The fallback
  when no subject is known (wallet not connected, not signed in).
- `LocalConversationStore` — optional, and see the privacy note below.
- `ServerConversationStore` — the real one.

`AgentPanel` never learns which it got. The provider owns the choice.

### Storage shape

Follow `src/lib/offramp/transaction-history.ts`, which already does exactly
this pattern against Upstash:

```
agent:convo:<subjectId>          # list, append-only, newest last
agent:convo:<subjectId>:meta     # { readCount, updatedAt }
```

A list rather than one blob: `append` is then O(1) and two devices writing
at once interleave rather than clobbering each other.

- **Cap**: `LTRIM` to the most recent 100 messages on every append.
- **TTL**: 30 days, refreshed on write. A dormant thread is not worth
  keeping, and this bounds the store without a sweeper.
- **Route**: `/api/agent/conversation/[subjectId]`, GET/POST/DELETE — the
  same shape as `/api/notifications/[address]`.

### Authorisation

This is the part to get right. The thread contains bank account numbers and
account holder names, so the route must not serve a conversation to anyone
who names a `subjectId`.

Until accounts land there is no session to check, which is the second
reason to wait: a per-address route with no auth is a data leak, not a
feature. Once there is a session, the route derives `subjectId` from it and
ignores any client-supplied value.

### Stale quotes on restore

A restored thread contains `order` cards whose quotes have expired. Nothing
should let a user confirm a rate nobody quoted.

On load, any message with an `order` and no `orderStatus` older than the
quote's validity is marked `superseded`. It stays visible — the thread
should still read as history — but renders without Confirm/Cancel, with a
line saying the quote expired and an action to re-quote.

### What is deliberately not stored

- `offrampStep` and the run's progress — see above.
- `isSending`, `confirming`, scroll position, and other transient UI.
- The typing indicator.

## Open work

- [ ] **Re-subscribe to the run's stream on mount.** Independent of the
      store, and the other half of the original bug: the thread now
      survives a tab switch, but narration of a transfer already in flight
      still stops, because `offrampStep` lives in `StellarampDashboard`,
      which does unmount.
- [ ] **The parse route is slow** — 12-30s warm, measured repeatedly
      against the dev server. This is what surfaces as "I couldn't reach
      the server": `AgentPanel`'s catch cannot tell a timeout from an
      outage. Needs profiling before anything else here matters.
- [ ] Decide the privacy stance on `LocalConversationStore`.
      `TransactionStorage` already writes comparable data to
      `localStorage`, so there is precedent — but precedent is a reason to
      review it, not to assume it is fine. Plaintext, readable by any
      script on the origin, and it survives logout unless cleared.
