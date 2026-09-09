# Settle

Settle is a Next.js app that bridges fiat and **Stellar USDC** in both directions:

- **Offramp** — Stellar USDC → Base (via Allbridge) → fiat payout (via Paycrest)
- **Onramp** — fiat (via Paycrest) → custodial Base hot wallet → Stellar USDC (via Allbridge), delivered to the user's Stellar address

Server-side state (order status, bridge progress, platform stats) is backed by **Upstash Redis**; the browser only keeps a local transaction-history cache.

## Tech Stack

- Next.js 15 (App Router)
- React 19 + TypeScript
- Tailwind CSS v4
- Stellar SDK + Stellar Wallets Kit (wallet discovery, signing, WalletConnect on mobile)
- Allbridge Bridge Core SDK (Base ⇄ Stellar bridging)
- viem (Base chain transfers, custodial hot wallet)
- Upstash Redis (order/status stores)
- Telegram Bot API (operational alerts + manual retry commands)

## Features

### Offramp (Stellar USDC → fiat)
- Connect Stellar wallet via Stellar Wallets Kit (Freighter, LOBSTR, xBull, Albedo, Hana, Ledger on desktop; Freighter/LOBSTR mobile over WalletConnect)
- Get a USDC → fiat quote, verify recipient bank account
- Build and sign the Stellar → Base bridge transaction (XDR)
- Submit to Stellar Horizon, poll bridge status
- Execute payout server-side (Base USDC transfer + Paycrest order)
- Poll payout status via SSE stream

### Onramp (fiat → Stellar USDC)
- User pays fiat into a Paycrest-issued virtual account
- Paycrest settles USDC into the platform's custodial Base hot wallet (Paycrest has no native Stellar support)
- Server bridges Base → Stellar to the user's address once settled
- Destination defaults to the connected wallet, but the user can opt into a different Stellar address via a checkbox in the form
- **Hold-and-alert on failure**: if the bridge can't complete (e.g. hot wallet out of Base ETH for gas), funds stay put, the order is marked `bridge_failed`, and a Telegram alert asks for manual resolution — nothing is ever auto-refunded or silently retried
- A backstop cron (`/api/cron/finalize-onramp`) and the open SSE session both watch in-flight bridges and flip orders to `delivered` once Allbridge confirms on Stellar

### Operations (Telegram)
- Rich per-transaction alerts for every offramp/onramp status change (bank details, amount, rate, payout, Stellar address)
- Critical alerts for anything requiring manual action (e.g. `bridge_failed`)
- A stuck onramp bridge can be retried directly from Telegram — no admin app needed — by sending `/retry <orderId> [amount]` to the configured chat (see [Manual Bridge Retry](#manual-bridge-retry) below)

## Getting Started

### 1. Install

```bash
npm install
```

### 2. Configure env

```bash
cp .env.example .env.local
```

Set values in `.env.local`:

**Paycrest**
- `PAYCREST_API_KEY`
- `PAYCREST_WEBHOOK_SECRET`

**Offramp bridge (Stellar → Base)**
- `BASE_PRIVATE_KEY`
- `BASE_RETURN_ADDRESS` / `NEXT_PUBLIC_BASE_RETURN_ADDRESS`
- `BASE_RPC_URL` (optional, defaults to `https://mainnet.base.org`)
- `STELLAR_SOROBAN_RPC_URL` / `NEXT_PUBLIC_STELLAR_SOROBAN_RPC_URL` (optional)
- `STELLAR_HORIZON_URL` (optional)

**Onramp bridge (Base → Stellar, custodial)**
- `ONRAMP_HOT_WALLET_ADDRESS` / `ONRAMP_HOT_WALLET_PRIVATE_KEY` — platform-operated Base wallet; Paycrest delivers onramp USDC here, so it must be funded with a little Base ETH for gas
- `ONRAMP_MIN_GAS_ETH` (optional, default `0.0005`) — refuses to bridge below this ETH balance rather than risk a stranded tx

**Storage / stats**
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
- `STATS_SEED_USERS` / `STATS_SEED_VOLUME` (seed values shown before real activity accumulates)

**Telegram alerts + admin**
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — leave blank to disable alerts entirely
- `TELEGRAM_WEBHOOK_SECRET` — verifies inbound Telegram commands (see below)
- `ADMIN_API_SECRET` — protects the HTTP bridge-retry endpoint

**Cron**
- `CRON_SECRET` — Vercel Cron sends this as a Bearer token to `/api/cron/finalize-onramp`

**Wallet connect**
- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` — from [dashboard.walletconnect.com](https://dashboard.walletconnect.com) (now also branded Reown). Required for mobile: phones have no browser extensions, so mobile wallets are only reachable over WalletConnect. Desktop extensions still work without it.

  Add every origin the app is served from to that project's **allowed domains** — including tunnels used for mobile testing. An origin that isn't listed fails at connect time with WebSocket close code `3000 — origin not allowed`, which surfaces in the UI as a domain-allowlist message.

### 3. Run

```bash
npm run dev
```

Open `http://localhost:3000`.

## Manual Bridge Retry

If an onramp bridge is stuck — most commonly because the hot wallet ran out of Base ETH for gas — fund the hot wallet, then retry the bridge for that order id. Both paths share the same lock-guarded, idempotent logic (`src/lib/onramp/retry-bridge.ts`), so retrying a bridge already in flight is a safe no-op.

**Via Telegram** (register once per deployment):

```bash
curl -G "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  --data-urlencode "url=https://<your-deployment>/api/webhooks/telegram" \
  --data-urlencode "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

Then, in the configured chat:

```
/retry <orderId> [amount]
```

`amount` is only needed if the order never made it to `settled` in the store (so no USDC amount was persisted) — pass the settled USDC amount from the Paycrest webhook/dashboard in that case.

**Via HTTP:**

```bash
curl -X POST https://<your-deployment>/api/admin/onramp/retry-bridge \
  -H "Authorization: Bearer $ADMIN_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"<orderId>","amount":"<optional override>"}'
```

## API Routes

### Offramp
- `POST /api/offramp/quote`
- `GET /api/offramp/currencies`
- `GET /api/offramp/institutions/[currency]`
- `POST /api/offramp/verify-account`
- `POST /api/offramp/paycrest/order` — create the Paycrest payout order
- `GET /api/offramp/paycrest/order/[orderId]`
- `GET /api/offramp/status/[orderId]`
- `GET /api/offramp/stream/[orderId]` — SSE status stream

### Offramp bridge (Stellar → Base)
- `POST /api/offramp/bridge/build-tx`
- `GET /api/offramp/bridge/gas-fee-options`
- `POST /api/offramp/bridge/submit-soroban`
- `GET /api/offramp/bridge/status/[txHash]`
- `GET /api/offramp/bridge/tx-status/[hash]`

### Onramp
- `POST /api/onramp/order` — create the Paycrest onramp order; persists the user's destination Stellar address
- `GET /api/onramp/order/[orderId]`
- `GET /api/onramp/stream/[orderId]` — SSE status stream, also drives fast-path bridge finalization
- `GET /api/onramp/bridge/status/[txHash]`

### Webhooks
- `POST /api/webhooks/paycrest` — routes onramp vs. offramp by looking up which store the order lives in (Paycrest's payload has no reliable direction field)
- `POST /api/webhooks/telegram` — inbound `/retry` command handling

### Cron
- `GET /api/cron/finalize-onramp` — backstop sweep of in-flight onramp bridges

### Admin
- `POST /api/admin/onramp/retry-bridge` — manually re-trigger a stuck onramp bridge

### Misc
- `GET/POST /api/stats` — platform stats (seeded + accumulated)

## Storage Model

- **Server (Upstash Redis)** is the source of truth for anything that survives a page close or webhook retry:
  - Onramp order state + Base→Stellar bridge progress (`onramp:order:*`, `onramp:pending-bridges`)
  - Offramp payout status (`payout:*`) and order metadata for alert enrichment (`paycrest:order-meta:*`)
  - Platform stats (seeded values + real accumulated activity)
- **Browser `localStorage`** (`stellaramp_transactions`, max 50 records, scoped by connected wallet) is a client-side history cache only — not authoritative.

## Scripts

```bash
npm run dev
npm run build
npm run start
npm run lint
```

## Notes

- Onramp is custodial by design between fiat settlement and Stellar delivery: Paycrest has no native Stellar support, so USDC always transits the platform's Base hot wallet before being bridged onward. The hold-and-alert failure policy exists specifically to keep that window safe — funds are never auto-refunded or blindly retried.
- Keep `.env.local`, `.next`, and `node_modules` out of version control (already covered by `.gitignore`).
