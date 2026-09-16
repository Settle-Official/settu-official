# Settu — Task List

Running list of work that isn't yet tracked in a PR. Add to it freely.

Ordering within a section is rough priority. Anything touching money movement
gets a security note before it gets built.

---

## 1. Ops: admin dashboard

**Why:** every recovery so far was blocked on *seeing* what was stuck, never on
acting. The actions already exist:

| Route | Function |
|---|---|
| `/api/admin/onramp/retry-bridge` | `retryOnrampBridge()` |
| `/api/admin/onramp/status` | `checkOnrampStatus()` |
| `/api/admin/cctp/revive-transfer` | `reviveStuckTransfer()` |
| `/api/admin/offramp/sweep-burns` | `reconcileUnregisteredBurns()` |
| `/api/admin/offramp/sweep-payouts` | — |

Diagnosis meant hand-correlating order meta + payout status + Paycrest live
status + CCTP record + on-chain burn, once per incident.

### 1a. Automate what's still manual — do this first

- [ ] Auto-retry a `bridge_failed` onramp once before alerting. Three incidents
      needed a manual `retry-bridge` call that would have succeeded unattended.
- [ ] Decide whether the retry is unconditional or limited to known-transient
      failures (RPC lag on the approve, gas).

*A dashboard needed routinely is a symptom of missing automation. Close the gap
first so the dashboard is for exceptions.*

### 1b. Read-only triage view — highest value, no money moves

- [ ] One page listing everything non-terminal past its grace window: onramp
      orders, offramp orders, CCTP transfers.
- [ ] Per row, resolve the correlation automatically: order meta, local payout
      status, Paycrest live status, CCTP record + status, and whether a matching
      burn exists on-chain with no record (the orphaned-burn case).
- [ ] Surface the cause, not just the state — e.g. "burn confirmed, never
      registered" vs "abandoned before burning". Those look identical in Redis
      and need opposite responses.
- [ ] Ship before any action buttons.

### 1c. Actions — last, and behind real auth

- [ ] Wrap the existing routes as buttons.
- [ ] **New:** register an orphaned burn. The only recovery with no admin route;
      the public `register-transfer` was used by hand for the stranded Solana
      and 70 USDC Stellar burns.
- [ ] Confirmation step showing amount and destination for anything
      irreversible.

**Security — decide before building:**

- [ ] Replace the shared `ADMIN_API_SECRET` bearer token for browser use.
      Acceptable for curl; not for a browser surface that mints and settles real
      money. Authenticate against the auth backend with an admin role.
- [ ] **Audit log every action:** who, what, before/after state. Today a
      recovery leaves no record of who triggered it.
- [ ] Never render secrets, keys, or full bank details.
- [ ] Rate limit, and keep each route's own auth — don't trust the UI.

**Open question:** the Telegram bot is already an admin surface with action
buttons, authenticated by chat membership, working on mobile. Possibly
dashboard for *seeing*, Telegram for *doing*, rather than rebuilding actions.

---

## 2. Reliability

- [ ] `EVM_MAX_CHUNKS` in the burn backstop: on sub-second-block chains
      (Arbitrum) the 24 × 2,000-block cap is reached before 24h of history. Fine
      at the current 5-minute sweep cadence; a prolonged sweep outage could let
      an older Arbitrum strand slip past.
- [ ] Burn backstop `GRACE_MS` is 8 minutes, so a burn stranded seconds ago is
      invisible to the sweep and to any dashboard built on it. Worth surfacing
      such orders as "too new to auto-recover" rather than hiding them.

---

## 3. Security / hygiene

- [ ] **`/api/offramp/paycrest/order` has no caller identity check**, and there
      is no rate limiting anywhere in the codebase. It creates a real Paycrest
      order against our API key, so anyone reading the frontend's network tab
      can call it directly, in a loop. Effectively an undocumented, unmetered
      public API today. Fix regardless of whether we ever ship a partner API.
- [ ] Rotate `BASE_PRIVATE_KEY` and audit that wallet — recommended after the
      unauthenticated `execute-payout` route was removed in #35.
- [ ] `POST /api/stats` is unauthenticated and accepts an arbitrary `wallet`,
      `volume` and `transaction`. Live stats-poisoning vector.
- [ ] `/account` still builds and is reachable by URL in production; only the
      header entry point is hidden.
- [ ] Delete merged branches on the remote.

---

## 4. Product

- [ ] **Cashback.** Unblocked now that accounts and multi-chain wallet linking
      exist. Ships with `CASHBACK_ENABLED=false` and refuses to accrue unless
      both a rate and a total programme budget ceiling are set. Team funds the
      pot; all chains linkable, Stellar and Solana earn.
- [ ] Decide the cashback rate and budget ceiling.
- [ ] PR #44 — Stellar offramp attribution via Horizon `source_account` instead
      of a client-supplied address. Still open; attribution has to be proof
      before cashback pays out on it.

---

## 5. API / partner access

Several people have asked for offramp API access. Buildable, but two of the
three blockers aren't engineering, so the order matters.

### 5a. Answer these before building anything

- [ ] **Ask Paycrest whether reselling is permitted.** Partner volume would flow
      through our account and our key. Providers commonly forbid this outright or
      require a different commercial tier. One email, and a "no" makes the rest
      moot — so it goes first.
- [ ] **Get a legal read on the change in position.** Today users move their own
      funds and Paycrest KYCs the recipient. Via an API, partners move funds for
      users we never see, which looks less like an app and more like payments
      infrastructure — with NGN payouts and CBN's VASP rules in scope. Decide
      this deliberately, not after launch.
- [ ] **Confirm what askers actually want.** "Let my users offramp from inside my
      product" is usually solved by an embeddable widget or hosted checkout link:
      we keep the user relationship, KYC stays as it is, and there's no
      idempotency/webhook surface to get right. Raw API keys are the heaviest
      possible answer to that request.

### 5b. Technical prerequisites

- [ ] **Idempotency keys on order creation.** The biggest blocker. Nothing in the
      codebase implements idempotency, and partners retry automatically — a
      retried timeout today creates a *second* Paycrest order, potentially after
      funds were already burned against the first.
- [ ] Per-partner API keys: hashed at rest, scoped, revocable, individually rate
      limited. The accounts backend is the natural home.
- [ ] Outbound webhooks so partners learn about settlement without polling,
      with signatures and retries.
- [ ] Per-partner ledger and reconciliation — whose volume, whose failures.
- [ ] Sandbox environment and versioned, documented endpoints.

### 5c. Operational prerequisites

These are already listed above; an API turns them from internal pain into
partner-facing SLA breaches, since every manual recovery becomes a support
ticket from a business rather than a test on our own phone.

- [ ] Onramp auto-retry (§1a)
- [ ] Postgres migration (§6) — 48h/7d retention means a partner disputing last
      month's settlement has nothing to dispute against
- [ ] Audit log (§1c)
- [ ] Admin triage view (§1b)

---

## 6. Redis → Postgres

**Decision: move the system of record, keep Redis as the coordination layer.**
Neon is already provisioned.

| Store | TTL today | |
|---|---|---|
| order-meta | 48h | → Postgres |
| payout | 48h | → Postgres |
| cctp-transfer | 7d | → Postgres |
| onramp-order | 7d | → Postgres |
| funds-ledger | none | → Postgres |
| transaction-history | none | → Postgres |
| stats | none | → Postgres |
| `cctp:advance-lock`, `onramp:bridge-lock` | — | **stay on Redis** |

**Why move:**

- Money records evaporate. A stranded burn found 8 days later can't be
  reconstructed from our own data — only from Horizon and Paycrest by hand.
- Every diagnosis so far was a full keyspace SCAN plus a hand-join across order
  meta, payout, Paycrest, CCTP record and the chain. One SQL query instead.
  The triage view (§1b) is quietly blocked on this.
- Cashback needs ACID for accrual, balances and withdrawals. The audit log
  (§1c) isn't really implementable on Redis either.

**Why the locks stay:** `cctp:advance-lock` is what prevents two workers
advancing the same transfer concurrently — losing single-flight risks a double
mint. Redis is better at this and there's no upside to moving it.

**Tasks**

- [ ] Use `@neondatabase/serverless` (HTTP) from Next.js, not `pg` with a pool —
      Vercel's serverless functions will exhaust a normal pool.
- [ ] Give Next.js its own schema. The Rust service already owns
      `users`/`sessions`/`wallets` via sqlx; two migration owners on one database
      is a footgun.
- [ ] Watch cold starts — we already hit >10s on the Rust side, and the offramp
      SSE stream polls every 3s.
- [ ] Migrate dual-write → read Postgres → stop writing Redis. Never big-bang;
      it's live money.
- [ ] Backfill only the three permanent stores. Orders, payouts and CCTP records
      expire within 7 days, so dual-write and wait them out.
- [ ] Normalise addresses on day one: `offramp:tx:by-address` lowercases while
      `stellaramp:known_wallets` doesn't, so one EVM wallet can appear as two.
      Keep original casing separately for display — Stellar `G…` is
      case-sensitive.

---

## 7. Known gaps (documented, not yet scheduled)

- [ ] `transaction-history` misses every Stellar offramp: `recordTransaction`
      sits behind `if (connectedAddress)` and the Stellar client never sends it.
- [ ] `destinationAmount` is a permanent `"0"` on the CCTP path.
- [ ] `updateTransactionStatus` has no callers, so those records never leave
      `status: "pending"`.
- [ ] `revive.ts` sets `delivered` directly, bypassing `markOnrampDelivered`.

All five matter for cashback.
