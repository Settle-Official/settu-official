# Settu Landing Page

## Context

Settu currently has no marketing entry point — `src/app/page.tsx` renders
`StellarampDashboard` directly, so `/` *is* the app. This spec adds a real
landing page at `/` (Figma: file `6WCZ1UfpIPbwEu06cgKJHV`, frame "LANDING
PAGE", desktop node `654:7997`, mobile node `636:1015`), and moves the
existing dashboard to `/app`.

The landing design has its own visual language — dark background with a gold
accent, but its own gradients, fonts, and spacing distinct from the
dashboard's `globals.css` tokens — built deliberately as a separate surface
rather than reusing the product's design system.

## Decisions (from user Q&A)

- **Routing**: the landing page takes over `/`. `StellarampDashboard` moves
  to `/app`. Anything currently linking to `/` as "the app" needs to point
  at `/app` instead (PWA manifest `start_url`, any hardcoded internal links).
- **Visual system**: independent of the dashboard's CSS variables
  (`--bg`, `--accent`, etc.) — colors/fonts/spacing are pulled directly from
  the Figma file per section, scoped to the landing components only. The
  dashboard's theme system is untouched.
- **CTA behavior**: every "Convert USDC Now" / "Connect Wallet" button is a
  plain link to `/app` — no query params, no pre-selected mode. Lands on the
  dashboard exactly as it works today.
- **Responsive**: built from the actual Figma mobile frame (`636:1015`,
  390px), not improvised. Mobile mirrors desktop section-for-section, with
  the nav's inline links replaced by a hamburger menu (the mobile frame has
  the link row marked `hidden` and a menu-icon frame in its place).
- **Interactivity**: subtle polish only — scroll-in fade/slide for sections,
  hover states on buttons/cards, and a working FAQ accordion (click to
  expand/collapse, one item open at a time, matching the file's shown
  state). Nothing beyond that; no interactions invented that the design
  doesn't call for.
- **Copy**: verbatim from Figma except one typo fix — the nav's "How is
  works" becomes "How it works" (matches the section heading exactly
  elsewhere in the same file).

## Content inventory

One continuous scrolling page, six sections, same order on desktop and
mobile:

1. **Hero** — nav (`$ETTU` logo, "How it works" / "Security" / "FAQ" /
   "Support", "Connect Wallet" pill), headline "Convert USDC to your bank
   account", subtext "Move USDC across chains and land it directly in your
   account. No P2P traders. No waiting. Just simple transfers.", "Convert
   USDC Now" CTA, a decorative coin/piggy-bank illustration cluster, and a
   background of grid lines + radial gradient glow + floating dots.
2. **Stats strip** — `₦480M+` "Settled to Nigerian banks", `6,200+`
   "Transfer completed", `< 90 sec` "Typical time to payout", plus a row of
   six chain/token logos (ETH, Base, Arbitrum, Solana, and two more generic
   token marks).
3. **How it works** — heading "How $ettu actually moves your money",
   subtext "Three steps, and we tell you where things stand at each one,
   not just at the end.", three cards, each a small realistic mock of the
   real app UI:
   - *Connect wallet* — Stellar/Metamask connect rows, caption "Connect
     wallet" / "Any EVM wallet or a Stellar wallet works. If you're not on
     Stellar, we bridge your USDC there automatically, you don't manage
     that step yourself."
   - *Your rate locks instantly* — an "FX lock" card showing a sample rate
     (`1380/USDC`), caption "Your rate locks instantly" / "The Naira rate
     you're quoted is the rate you get, held for a short window while you
     confirm. No surprises at the last step."
   - *Naira lands in your bank* — payout-currency dropdown + account
     number/bank fields + a "Sent to GTBank •••• 6789. It usually lands
     within minutes." confirmation strip, caption "Naira lands in your
     bank" / "You'll see each stage, bridging, locking, sending, in plain
     language, and a clear 'done' the moment it's in your account."
4. **Trust section** — "$ETTU" kicker, heading "Why people trust it with
   real money", subtext "Not badges — specifics about what happens to your
   funds, and what other users actually say.", three staggered callouts
   connected by a hand-drawn-style connector line:
   - "01- Non-custodial by design" — "Your USDC moves directly from your
     wallet to your bank via Stellar's settlement network. Settu never
     holds a balance on your behalf."
   - "02- Rates locked before you commit" — "You see the exact Naira amount
     before you sign anything. Once locked, it doesn't move against you
     mid-transfer."
   - "Every fee, named" — "Network, bridge, and platform fees are shown
     separately with a plain-language reason for each, no bundled surprise
     charges."
5. **FAQ** — kicker pill "FAQ", heading "Questions people actually ask",
   five accordion items. Only the first is shown expanded in the file:
   - "What exactly am I being charged for?" (expanded) — "Three separate
     things: a network fee (goes to the blockchain, not us), a bridge fee
     (only if you're sending from a non-Stellar chain), and a platform fee
     (covers the rate lock and payout). Every transfer shows all three
     before you confirm."
   - "What happens if my transfer fails?" (collapsed — answer text not yet
     pulled, see Open Items)
   - "Do I need a Stellar wallet specifically?" (collapsed — same)
   - "What's an \"FX lock\"?" (collapsed — same)
   - "Which banks are supported?" (collapsed — same)
6. **Footer** — oversized "$ETTU" wordmark treatment, nav links repeated
   ("How it works" / "Security" / "FAQ" / "Support"), LinkedIn + X icons.

## Architecture

### Routing

- `src/app/page.tsx` → new `LandingPage` component (was `StellarampDashboard`).
- New `src/app/app/page.tsx` → renders `StellarampDashboard` (unchanged
  component, just relocated route).
- Update `public/manifest.json`'s `start_url` (and any other hardcoded `"/"`
  references meant as "open the app") to `/app`.
- No changes to `/account`, `/forgot-password`, `/reset-password`,
  `/verify-email` — those stay where they are.

### Component structure

New `src/components/landing/` directory, one component per section, composed
by a top-level `LandingPage`:

- `LandingPage.tsx` — composes sections in order, owns nothing but layout
- `Hero.tsx` — nav + headline + CTA + background art
- `StatsStrip.tsx`
- `HowItWorks.tsx` — renders the three step-card sub-components
- `TrustSection.tsx`
- `Faq.tsx` — owns the accordion's open/closed state
- `Footer.tsx`

Each section is a plain server-renderable component where possible;
`Faq.tsx` needs `"use client"` for the accordion's interactive state, and the
mobile nav's hamburger toggle needs a small client component too. Everything
else can stay a server component.

### Styling

Own CSS scope, not `globals.css` — a `src/components/landing/landing.css`
(or CSS Modules per component, decided at implementation time) holding the
landing-specific color/font/spacing values pulled from Figma. The dashboard's
existing theme variables and dark/light toggle are untouched by this work —
the landing page does not participate in that toggle.

### Assets

Every icon, logo, and illustration is exported from Figma and committed as a
real file (never hand-drawn/recreated) — chain/token logos, social icons,
the hero illustration cluster, the trust-section connector line, the
hamburger menu icon. Exported once during implementation and committed
under `public/landing/` (or co-located with the components — decided at
implementation time), not left pointing at Figma's short-lived asset URLs.

### Responsive

Two explicit layouts sourced from the two Figma frames (desktop 1440px,
mobile 390px), not a single design guessed into a fluid layout. Tablet
widths interpolate between the two using the same breakpoint conventions
already used elsewhere in this codebase (e.g. `max-[720px]:`). The mobile
nav swaps the inline link row for a hamburger menu that opens a full-width
dropdown/sheet with the same four links.

### Interactivity

- FAQ accordion: click a question to expand it; expanding one collapses any
  other open item (matches the single-expanded state shown in the file).
- Scroll-in animation: sections fade/slide into view on first scroll
  intersection (e.g. `IntersectionObserver` + a CSS transition), not a
  heavier animation library — consistent with how light this page needs to
  stay.
- Hover states on buttons and the three "how it works" cards.

## Open Items

- **Remaining FAQ answers**: only the first (expanded) item's answer text is
  visible in the file as-is. The other four need their answer text pulled
  from each component instance's expanded variant during implementation
  (or supplied directly if available) before `Faq.tsx` can be written with
  real copy.
- **Exact color/font/spacing values**: not pulled yet — `get_design_context`
  will be called per-section during implementation to get real values,
  rather than guessed from screenshots here.
