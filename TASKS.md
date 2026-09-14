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

## 5. Known gaps (documented, not yet scheduled)

- [ ] `transaction-history` misses every Stellar offramp: `recordTransaction`
      sits behind `if (connectedAddress)` and the Stellar client never sends it.
- [ ] `destinationAmount` is a permanent `"0"` on the CCTP path.
- [ ] `updateTransactionStatus` has no callers, so those records never leave
      `status: "pending"`.
- [ ] `revive.ts` sets `delivered` directly, bypassing `markOnrampDelivered`.
- [ ] Redis → Postgres migration for orders, payouts, ledger and stats.

All five matter for cashback.
