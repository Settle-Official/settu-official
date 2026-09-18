# Settu Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a real marketing landing page at `/`, move the existing dashboard to `/app`, and give the landing nav's "Connect Wallet" button real wallet-connect behavior — covering Hero, Stats strip, and How It Works (all three step cards) now. Trust section, FAQ, Footer, and the mobile (390px) breakpoint are deliberately **out of scope for this plan** — the Figma MCP hit its monthly quota (Starter plan: 20 calls/month) before those sections' exact colors/fonts/spacing could be pulled. They get their own follow-up plan once the quota resets or the plan is upgraded.

**Architecture:** New `src/components/landing/` tree (Nav, Hero, StatsStrip, HowItWorks + three step-card sub-components, composed by `LandingPage`), its own font set loaded via `next/font/google` and its own small `landing.css` for things Tailwind utilities can't express (the Fraunces variable-font axes, the hero's layered `mix-blend-plus-lighter` art, a scroll-reveal keyframe) — completely independent of the dashboard's `globals.css` tokens. `src/app/page.tsx` renders `LandingPage`; the dashboard moves to a new `src/app/app/page.tsx`. The nav's wallet button reuses `useStellarWallet()` directly — no new wallet logic.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind (arbitrary-value utilities for the exact Figma pixel values, matching this codebase's existing convention), `next/font/google` for Fraunces/Sora/Inter.

**Spec:** `docs/superpowers/specs/2026-09-18-landing-page-design.md` (content/decisions) and `docs/superpowers/specs/2026-09-18-landing-page-design-tokens.md` (exact colors/fonts/spacing/assets — read this alongside every task below, it has the full reasoning behind every value used here).

## Global Constraints

- Landing page components never reference the dashboard's CSS variables (`--bg`, `--accent`, `--line`, `--muted`, `--foreground`, etc.) and the dashboard never references landing's values — two fully independent visual systems, per spec.
- Every icon/logo/illustration is a real committed file under `public/landing/`, copied from the scratchpad extraction — never hand-drawn inline SVG, never recreated as a CSS shape standing in for real art.
- The nav's "Connect Wallet" button calls `useStellarWallet()`'s own `connect`/`disconnect`, and reflects `isConnecting`/`isConnected`/`wallet.publicKey` — no new wallet-connection code, no dependency on `StellarampDashboard`'s multi-chain `handleConnect`.
- Copy is verbatim from Figma except the nav's "How is works" → "How it works" fix.
- This repo has no component-level unit tests (only `src/lib` gets `node --test` coverage) — this plan's "verify" steps are `npx tsc --noEmit`, `npm run build`, and a manual browser check via the Chrome extension tools, not new test files. Don't invent component tests that don't match repo convention.
- Trust/FAQ/Footer/mobile: do not stub these with placeholder content or guessed styling "to be safe" — they're simply not built yet. `LandingPage` ends after How It Works until the follow-up plan lands.

---

### Task 1: Move the dashboard to `/app`, stand up the landing route

**Files:**
- Create: `src/app/app/page.tsx`
- Modify: `src/app/page.tsx`
- Modify: `public/manifest.json`
- Create: `src/components/landing/LandingPage.tsx` (empty shell for now)

**Interfaces:**
- Produces: `LandingPage` — a no-props component, default export not required (named export, matching this codebase's convention of named exports for components).

- [ ] **Step 1: Move the dashboard route**

Create `src/app/app/page.tsx`:

```tsx
import { StellarampDashboard } from "@/components/StellarampDashboard";

export default function Page() {
  return <StellarampDashboard />;
}
```

- [ ] **Step 2: Stand up the landing shell**

Create `src/components/landing/LandingPage.tsx`:

```tsx
export function LandingPage() {
  return (
    <main className="min-h-screen bg-[#131212] text-white">
      {/* Sections added in later tasks: Nav, Hero, StatsStrip, HowItWorks */}
    </main>
  );
}
```

Replace `src/app/page.tsx` with:

```tsx
import { LandingPage } from "@/components/landing/LandingPage";

export default function Page() {
  return <LandingPage />;
}
```

- [ ] **Step 3: Point the PWA manifest at the app, not the marketing page**

In `public/manifest.json`, change `"start_url": "/"` to `"start_url": "/app"` — installing the PWA from a phone should open the product, not the landing page.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

Run: `npm run build`
Expected: succeeds; route list shows both `○ /` and `○ /app`.

- [ ] **Step 5: Commit**

```bash
git add src/app/page.tsx src/app/app/page.tsx src/components/landing/LandingPage.tsx public/manifest.json
git commit -m "feat(landing): move dashboard to /app, stand up landing page shell at /"
```

---

### Task 2: Landing fonts and shared CSS

**Files:**
- Create: `src/components/landing/landing.css`
- Modify: `src/components/landing/LandingPage.tsx`

**Interfaces:**
- Produces: CSS custom properties `--font-fraunces`, `--font-sora`, `--font-inter` (via `next/font/google`, applied as a className on `LandingPage`'s root element); a `.landing-fraunces` utility class carrying the exact `font-variation-settings` every heading in the design uses; a `.landing-reveal` scroll-in-view utility (element starts `opacity:0 translateY(16px)`, animates to visible when a `is-visible` class is added — the actual `IntersectionObserver` wiring is a later task, this just defines the CSS transition it drives).

- [ ] **Step 1: Add the font loaders**

In `src/components/landing/LandingPage.tsx`:

```tsx
import { Fraunces, Sora, Inter } from "next/font/google";
import "./landing.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["SOFT", "WONK"],
  variable: "--font-fraunces",
  display: "swap",
});
const sora = Sora({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-sora",
  display: "swap",
});
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-inter",
  display: "swap",
});

export function LandingPage() {
  return (
    <main
      className={`${fraunces.variable} ${sora.variable} ${inter.variable} min-h-screen bg-[#131212] text-white font-[family-name:var(--font-sora)]`}
    >
      {/* Sections added in later tasks */}
    </main>
  );
}
```

- [ ] **Step 2: Write the shared landing CSS**

Create `src/components/landing/landing.css`:

```css
/* Fraunces is used with its SOFT/WONK variable axes everywhere it appears
   (headlines, stat numbers, card titles) — a static weight cut renders
   the wrong letterforms, so every heading needs this exact class rather
   than just `font-[family-name:var(--font-fraunces)]`. */
.landing-fraunces {
  font-family: var(--font-fraunces), serif;
  font-variation-settings: "SOFT" 0, "WONK" 1;
}

/* Driven by an IntersectionObserver (added when each section is built) —
   toggling `is-visible` on is what actually reveals the section. */
.landing-reveal {
  opacity: 0;
  transform: translateY(16px);
  transition: opacity 0.6s ease-out, transform 0.6s ease-out;
}
.landing-reveal.is-visible {
  opacity: 1;
  transform: translateY(0);
}
@media (prefers-reduced-motion: reduce) {
  .landing-reveal {
    opacity: 1;
    transform: none;
    transition: none;
  }
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run build`
Expected: clean. (Fraunces with `axes: ["SOFT", "WONK"]` must resolve against Google's variable font — if the build errors on the `axes` option, check the exact axis tags Google Fonts exposes for Fraunces via `node_modules/@next/font` or fall back to `Fraunces({ variable: "--font-fraunces" })` without `axes` and apply `font-variation-settings` inline as a last resort; note whichever path was needed in the commit message.)

- [ ] **Step 4: Commit**

```bash
git add src/components/landing/LandingPage.tsx src/components/landing/landing.css
git commit -m "feat(landing): load Fraunces/Sora/Inter and shared landing CSS"
```

---

### Task 3: Commit the real assets

**Files:**
- Create: `public/landing/hero-illustration.png` (and 18 more files — see table below)

**Interfaces:**
- Produces: every file path referenced by Tasks 4–7's `<img>` tags.

- [ ] **Step 1: Copy every asset from the scratchpad into the repo**

```bash
mkdir -p public/landing
cp /tmp/claude-1000/-home-uche-ofatu-Desktop-stellaramp-next/4e825863-fed0-4bc8-b558-f32327bdc2dd/scratchpad/landing-assets/*.svg public/landing/
cp /tmp/claude-1000/-home-uche-ofatu-Desktop-stellaramp-next/4e825863-fed0-4bc8-b558-f32327bdc2dd/scratchpad/landing-assets/*.png public/landing/
```

This copies: `hero-illustration.png`, `hero-bg-grid.svg`, `hero-lightbeam-1.svg`, `hero-lightbeam-2.svg`, `hero-lightbeam-3.svg`, `hero-glow-ellipse.svg`, `hero-floating-dots.svg`, `hero-bottom-glow.svg`, `chain-logo-1-stellar.png` through `chain-logo-7-symbol.png`, `stats-glow-left.svg`, `stats-glow-right.svg`, `step1-metamask-icon.png`, `step1-caption-wallet-icon.svg`, `step2-fx-lock-icon.svg`.

- [ ] **Step 2: Compress the oversized hero illustration**

It's 1.7MB PNG for a 417×264 display box (roughly 834×528 at 2x for retina) — resize and recompress with ImageMagick (already available on this machine):

```bash
convert public/landing/hero-illustration.png -resize 900x900\> -strip -quality 85 public/landing/hero-illustration.png
ls -la public/landing/hero-illustration.png
```

Expected: well under 300KB afterward. If `convert` isn't available in the actual build/CI environment, do the same resize with the `sharp` package already present in `node_modules` via a one-off Node script instead — either way, the file committed to git must be the compressed one.

- [ ] **Step 3: Open each chain-logo PNG and confirm what it actually depicts**

Figma's own layer names for these are unreliable (confirmed in the design-tokens doc — e.g. a node named "solana_symbol.png" doesn't visually look like the Solana logo). Open all 7 (`public/landing/chain-logo-*.png`) and rename/relabel them to match what they actually show before wiring them into the Stats strip in Task 6 — don't trust the placeholder names carried over from Figma's export.

- [ ] **Step 4: Verify**

```bash
ls public/landing/ | wc -l
```
Expected: 19 files (or however many remain after Step 3's renaming — same count, possibly different names).

- [ ] **Step 5: Commit**

```bash
git add public/landing/
git commit -m "feat(landing): commit real Figma-exported assets for hero/stats/step cards"
```

---

### Task 4: Nav with real wallet connection

**Files:**
- Create: `src/components/landing/Nav.tsx`
- Modify: `src/components/landing/LandingPage.tsx`

**Interfaces:**
- Consumes: `useStellarWallet()` from `@/hooks/useStellarWallet` — `{ wallet, isConnected, isConnecting, connect, disconnect }`.
- Produces: `Nav` — a `"use client"` component, no props (owns its own wallet-hook call).

- [ ] **Step 1: Write the Nav component**

Create `src/components/landing/Nav.tsx`:

```tsx
"use client";

import { useStellarWallet } from "@/hooks/useStellarWallet";

const NAV_LINKS = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Security", href: "#security" },
  { label: "FAQ", href: "#faq" },
  { label: "Support", href: "#support" },
];

export function Nav() {
  const { wallet, isConnected, isConnecting, connect, disconnect } = useStellarWallet();

  const buttonLabel = isConnecting
    ? "Connecting…"
    : isConnected && wallet?.publicKey
      ? `${wallet.publicKey.slice(0, 4)}...${wallet.publicKey.slice(-4)}`
      : "Connect Wallet";

  return (
    <nav className="mx-auto mt-[20px] flex w-[890px] max-w-[calc(100%-32px)] items-center justify-between rounded-[40px] bg-[rgba(255,255,255,0.1)] px-[10px] py-[10px]">
      <div className="flex w-[120px] items-center gap-[4px] p-[10px]">
        <span className="landing-fraunces text-[24px] font-semibold text-[#c9a962]">$</span>
        <span className="font-[family-name:var(--font-inter)] text-[24px] text-white">ETTU</span>
      </div>
      <div className="flex items-center gap-[50px]">
        {NAV_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="font-[family-name:var(--font-sora)] text-[18px] text-white hover:text-[#c9a962] transition-colors"
          >
            {link.label}
          </a>
        ))}
      </div>
      <button
        type="button"
        onClick={isConnected ? disconnect : connect}
        disabled={isConnecting}
        className="rounded-[40px] bg-[rgba(201,169,98,0.2)] px-[16px] py-[16px] font-[family-name:var(--font-sora)] text-[16px] text-white transition-colors hover:bg-[rgba(201,169,98,0.35)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {buttonLabel}
      </button>
    </nav>
  );
}
```

- [ ] **Step 2: Mount it in LandingPage**

In `src/components/landing/LandingPage.tsx`, import and render `<Nav />` as the first child inside `<main>`.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

Then start the dev server and check in the browser (Chrome extension tools): navigate to `/`, confirm the nav renders, click "Connect Wallet" — the Stellar Wallets Kit modal should open exactly as it does on the dashboard's header button, and the button label should update through connecting → truncated address once connected, and back to "Connect Wallet" on disconnect.

- [ ] **Step 4: Commit**

```bash
git add src/components/landing/Nav.tsx src/components/landing/LandingPage.tsx
git commit -m "feat(landing): nav bar with real Stellar wallet connect/disconnect"
```

---

### Task 5: Hero section

**Files:**
- Create: `src/components/landing/Hero.tsx`
- Modify: `src/components/landing/LandingPage.tsx`

**Interfaces:**
- Produces: `Hero` — no props, server component (no client-only state needed).

- [ ] **Step 1: Write the Hero component**

Create `src/components/landing/Hero.tsx`. The background is layered absolutely-positioned art (grid, three rotated light beams with `mix-blend-mode: plus-lighter`, a glow ellipse, a floating-dots pattern, a bottom glow), not a flat CSS gradient — per the design-tokens doc's per-section notes:

```tsx
import Image from "next/image";

export function Hero() {
  return (
    <section className="relative overflow-hidden px-[257px] pt-[59px] pb-[103px]">
      {/* Background layers */}
      <div className="pointer-events-none absolute inset-0">
        <Image src="/landing/hero-bg-grid.svg" alt="" fill className="object-cover opacity-40" />
        <Image
          src="/landing/hero-lightbeam-1.svg"
          alt=""
          width={243}
          height={378}
          className="absolute right-0 top-0 mix-blend-plus-lighter rotate-[18.49deg]"
        />
        <Image
          src="/landing/hero-lightbeam-2.svg"
          alt=""
          width={184}
          height={368}
          className="absolute right-[80px] top-0 mix-blend-plus-lighter rotate-[7.78deg]"
        />
        <Image
          src="/landing/hero-lightbeam-3.svg"
          alt=""
          width={148}
          height={356}
          className="absolute right-[160px] top-0 mix-blend-plus-lighter rotate-[1.71deg]"
        />
        <Image
          src="/landing/hero-glow-ellipse.svg"
          alt=""
          width={362}
          height={402}
          className="absolute right-0 top-0 rotate-[34.05deg]"
        />
        <Image src="/landing/hero-floating-dots.svg" alt="" width={302} height={230} className="absolute right-[40px] top-[47px]" />
        <Image
          src="/landing/hero-bottom-glow.svg"
          alt=""
          width={962}
          height={962}
          className="absolute bottom-[-500px] left-1/2 -translate-x-1/2"
        />
      </div>

      {/* Content */}
      <div className="relative mx-auto flex w-[765px] max-w-full flex-col items-center gap-[34px] pt-[112px] text-center">
        <Image
          src="/landing/hero-illustration.png"
          alt="Coins converting to a bank deposit"
          width={417}
          height={264}
          className="h-auto w-[417px] max-w-full"
          priority
        />
        <div className="flex flex-col items-center gap-[19px]">
          <h1 className="landing-fraunces text-[50px] uppercase leading-tight text-[#c9a962]">
            Convert USDC to your bank account
          </h1>
          <p className="landing-fraunces text-[20px] leading-[26px] text-[#fdf8f8]">
            Move USDC across chains and land it directly in your account. No P2P
            traders. No waiting. Just simple transfers.
          </p>
        </div>
        <a
          href="/app"
          className="rounded-[40px] bg-[rgba(201,169,98,0.6)] px-[16px] py-[16px] font-[family-name:var(--font-sora)] text-[16px] text-white transition-colors hover:bg-[rgba(201,169,98,0.8)]"
        >
          Convert USDC Now
        </a>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Mount it in LandingPage**

Render `<Hero />` right after `<Nav />` in `src/components/landing/LandingPage.tsx`.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

In-browser: confirm the headline/subtext/CTA render, the hero illustration loads (no broken image), and the "Convert USDC Now" link goes to `/app`. Exact pixel positioning of the background light-beam layers is a visual judgment call against the Figma screenshot (`docs/superpowers/specs/2026-09-18-landing-page-design-tokens.md` references node `654:7999`/`654:8034` for the original absolute coordinates if the layering looks off) — adjust the `right-[…]`/`top-[…]` offsets to match rather than treating the values above as exact.

- [ ] **Step 4: Commit**

```bash
git add src/components/landing/Hero.tsx src/components/landing/LandingPage.tsx
git commit -m "feat(landing): hero section with layered background art and CTA"
```

---

### Task 6: Stats strip

**Files:**
- Create: `src/components/landing/StatsStrip.tsx`
- Modify: `src/components/landing/LandingPage.tsx`

**Interfaces:**
- Produces: `StatsStrip` — no props, server component.

- [ ] **Step 1: Write the component**

Create `src/components/landing/StatsStrip.tsx`. Uses the renamed/confirmed chain-logo files from Task 3 Step 3 — update the `logos` array below with whatever those files actually end up named:

```tsx
import Image from "next/image";

const STATS = [
  { value: "₦480M+", caption: "Settled to Nigerian banks" },
  { value: "6,200+", caption: "Transfer completed" },
  { value: "< 90 sec", caption: "Typical time to payout" },
];

// Update these filenames to match Task 3 Step 3's confirmed identities —
// Figma's own export names for these were unreliable.
const LOGOS = [
  "/landing/chain-logo-1-stellar.png",
  "/landing/chain-logo-2-eth.png",
  "/landing/chain-logo-3-base.png",
  "/landing/chain-logo-4-arbitrum.png",
  "/landing/chain-logo-5-token.png",
  "/landing/chain-logo-6-solana.png",
  "/landing/chain-logo-7-symbol.png",
];

export function StatsStrip() {
  return (
    <section className="relative overflow-hidden bg-[#121212] px-[100px] py-[100px]">
      <Image src="/landing/stats-glow-left.svg" alt="" width={370} height={186} className="pointer-events-none absolute left-[142px] top-[251px]" />
      <Image src="/landing/stats-glow-right.svg" alt="" width={370} height={186} className="pointer-events-none absolute right-[142px] top-[251px]" />
      <div className="relative mx-auto flex w-[1240px] max-w-full flex-col items-center gap-[50px]">
        <div className="flex items-start justify-center gap-[136px]">
          {STATS.map((stat) => (
            <div key={stat.caption} className="flex w-[219px] flex-col items-center gap-[9px] text-center">
              <span className="landing-fraunces text-[50px] text-white">{stat.value}</span>
              <span className="font-[family-name:var(--font-sora)] text-[18px] text-[#d0cccc]">{stat.caption}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-[59px]">
          {LOGOS.map((src, i) => {
            const hasBackdrop = i > 0 && i < LOGOS.length - 1;
            return (
              <div
                key={src}
                className={`flex size-[56px] items-center justify-center rounded-full ${hasBackdrop ? "bg-[#f3f3f3]" : ""}`}
              >
                <Image src={src} alt="" width={30} height={30} className="size-[30px]" />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Mount it in LandingPage**

Render `<StatsStrip />` after `<Hero />`.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

In-browser: confirm the three stats and seven logos render, first and last logo circles have no backdrop fill and the middle five do (per the design-tokens doc's note on the 7-logo structure).

- [ ] **Step 4: Commit**

```bash
git add src/components/landing/StatsStrip.tsx src/components/landing/LandingPage.tsx
git commit -m "feat(landing): stats strip with chain logo row"
```

---

### Task 7: How It Works — heading + step card shell

**Files:**
- Create: `src/components/landing/HowItWorks.tsx`
- Create: `src/components/landing/StepCard.tsx`
- Modify: `src/components/landing/LandingPage.tsx`

**Interfaces:**
- Produces: `StepCard` — `{ icon: string; iconAlt: string; title: string; description: string; children: React.ReactNode }`, a shared shell every step card (all three) renders inside. `HowItWorks` — no props, composes the heading + three `StepCard` usages built in Tasks 7–9.

- [ ] **Step 1: Write the shared step-card shell**

Create `src/components/landing/StepCard.tsx` (dimensions/padding/radius/background are exact — 362×483, `rounded-[40px]`, `p-[30px_50px]`, `bg-[rgba(255,255,255,0.1)]`, confirmed for cards 1 and 2 and assumed identical for card 3 per the design-tokens doc):

```tsx
import Image from "next/image";

interface StepCardProps {
  readonly icon: string;
  readonly iconAlt: string;
  readonly title: string;
  readonly description: string;
  readonly children: React.ReactNode;
}

export function StepCard({ icon, iconAlt, title, description, children }: StepCardProps) {
  return (
    <div className="flex h-[483px] w-[362px] max-w-full flex-col justify-between rounded-[40px] bg-[rgba(255,255,255,0.1)] p-[30px_50px]">
      <div>{children}</div>
      <div className="flex flex-col gap-[20px]">
        <div className="flex items-center gap-[10px]">
          <Image src={icon} alt={iconAlt} width={24} height={24} />
          <h3 className="landing-fraunces text-[20px] text-white">{title}</h3>
        </div>
        <p className="font-[family-name:var(--font-sora)] text-[14px] leading-[24px] text-[#aba8a8]">
          {description}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the section heading + composition shell**

Create `src/components/landing/HowItWorks.tsx` (step cards themselves are filled in by Tasks 8/9, left as `{/* Task 8 */}` etc. only within THIS step — Task 8/9 replace those comments with real content, this is not a shipped placeholder since the section isn't mounted until Task 9 completes it):

```tsx
export function HowItWorks() {
  return (
    <section id="how-it-works" className="px-[100px] py-[100px]">
      <div className="mx-auto flex w-[636px] max-w-full flex-col gap-[20px] pb-[100px] text-center">
        <div className="flex items-center justify-center gap-[10px]">
          <span className="h-[13px] w-[28px] rounded-[10px] border border-[#484747]" />
          <h2 className="landing-fraunces text-[30px] text-white">
            How $ettu actually moves your money
          </h2>
        </div>
        <p className="font-[family-name:var(--font-sora)] text-[16px] text-[#a9a5a5]">
          Three steps, and we tell you where things stand at each one, not just at the end.
        </p>
      </div>
      <div className="mx-auto flex w-[1240px] max-w-full justify-center gap-[77px]">
        {/* Task 8: Connect wallet card */}
        {/* Task 8: FX lock card */}
        {/* Task 9: Naira lands in bank card */}
      </div>
    </section>
  );
}
```

(Card-to-card gap of `77px` is derived from the row width `1240px` minus three `362px` cards divided across two gaps — not directly confirmed from Figma per the design-tokens doc's note that the row wrapper's own spacing wasn't captured; treat as a starting value to eyeball against the screenshot.)

- [ ] **Step 3: Mount the section shell in LandingPage**

Render `<HowItWorks />` after `<StatsStrip />`.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: clean (the two `{/* Task N */}` comments are valid JSX comments, not errors).

- [ ] **Step 5: Commit**

```bash
git add src/components/landing/HowItWorks.tsx src/components/landing/StepCard.tsx src/components/landing/LandingPage.tsx
git commit -m "feat(landing): how-it-works heading and step-card shell"
```

---

### Task 8: Step cards 1 and 2 — Connect wallet, FX lock

**Files:**
- Modify: `src/components/landing/HowItWorks.tsx`

**Interfaces:**
- Consumes: `StepCard` from Task 7.

- [ ] **Step 1: Build the "Connect wallet" card content**

Replace the first `{/* Task 8 */}` comment in `HowItWorks.tsx` with:

```tsx
<StepCard
  icon="/landing/step1-caption-wallet-icon.svg"
  iconAlt=""
  title="Connect wallet"
  description="Any EVM wallet or a Stellar wallet works. If you're not on Stellar, we bridge your USDC there automatically, you don't manage that step yourself."
>
  <div className="flex flex-col gap-[18px]">
    <div className="flex items-center gap-[18px] rounded-[20px] bg-[rgba(255,255,255,0.1)] p-[10px]">
      <Image src="/landing/chain-logo-1-stellar.png" alt="" width={56} height={56} className="rounded-full" />
      <div className="flex flex-col">
        <span className="landing-fraunces text-[20px] text-white">Stellar</span>
        <span className="font-[family-name:var(--font-sora)] text-[16px] text-white">wallet</span>
      </div>
      <span className="ml-auto font-[family-name:var(--font-inter)] text-[20px] font-semibold text-white">connect</span>
    </div>
    <div className="flex items-center gap-[18px] rounded-[20px] bg-[rgba(255,255,255,0.1)] p-[10px]">
      <Image src="/landing/step1-metamask-icon.png" alt="" width={56} height={56} className="rounded-full" />
      <div className="flex flex-col">
        <span className="landing-fraunces text-[20px] text-white">Metamask</span>
        <span className="font-[family-name:var(--font-sora)] text-[16px] text-white">wallet</span>
      </div>
      <span className="ml-auto font-[family-name:var(--font-inter)] text-[20px] font-semibold text-white">connect</span>
    </div>
  </div>
</StepCard>
```

Add `import Image from "next/image";` to the top of `HowItWorks.tsx`.

- [ ] **Step 2: Build the "FX lock" card content**

Replace the second `{/* Task 8 */}` comment with:

```tsx
<StepCard
  icon="/landing/step2-fx-lock-icon.svg"
  iconAlt=""
  title="Your rate locks instantly"
  description="The Naira rate you're quoted is the rate you get, held for a short window while you confirm. No surprises at the last step."
>
  <div className="flex items-center justify-between rounded-[20px] bg-[rgba(255,255,255,0.1)] p-[10px]">
    <div className="flex items-center gap-[10px]">
      <Image src="/landing/step2-fx-lock-icon.svg" alt="" width={33} height={33} />
      <span className="landing-fraunces text-[20px] text-white">FX lock</span>
    </div>
    <span className="font-[family-name:var(--font-sora)] text-[14px] font-semibold text-white">1380/USDC</span>
  </div>
</StepCard>
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

In-browser: confirm both cards render with real icons, matching the earlier Figma screenshots for these two steps (`docs/superpowers/specs/2026-09-18-landing-page-design-tokens.md` step-card section).

- [ ] **Step 4: Commit**

```bash
git add src/components/landing/HowItWorks.tsx
git commit -m "feat(landing): connect-wallet and FX-lock step cards"
```

---

### Task 9: Step card 3 — Naira lands in your bank

**Files:**
- Modify: `src/components/landing/HowItWorks.tsx`

**Interfaces:**
- Consumes: `StepCard` from Task 7.

This card's exact Figma values weren't captured (quota exhausted before it was reached) — built from the earlier screenshot and the shared `StepCard` shell's confirmed styling (same 362×483 card, same `rgba(255,255,255,0.1)` inner-row background used by every other row in this section, same fonts/sizes as sibling cards for consistency). Revisit against the real Figma node (`654:8141`) once quota allows.

- [ ] **Step 1: Build the card content**

Replace the third `{/* Task 9 */}` comment with:

```tsx
<StepCard
  icon="/landing/step1-caption-wallet-icon.svg"
  iconAlt=""
  title="Naira lands in your bank"
  description="You'll see each stage, bridging, locking, sending, in plain language, and a clear &quot;done&quot; the moment it's in your account."
>
  <div className="flex flex-col gap-[12px]">
    <div className="flex items-center justify-between rounded-[20px] bg-[rgba(255,255,255,0.1)] p-[10px]">
      <span className="font-[family-name:var(--font-sora)] text-[16px] text-white">Payout currency</span>
      <span className="text-white">⌄</span>
    </div>
    <div className="flex gap-[10px]">
      <div className="flex-1 rounded-[20px] bg-[rgba(255,255,255,0.1)] p-[10px] text-center font-[family-name:var(--font-sora)] text-[16px] text-white">
        account number
      </div>
      <div className="flex-1 rounded-[20px] bg-[rgba(255,255,255,0.1)] p-[10px] text-center font-[family-name:var(--font-sora)] text-[16px] text-white">
        Bank
      </div>
    </div>
    <div className="rounded-[20px] bg-[rgba(255,255,255,0.1)] p-[10px] font-[family-name:var(--font-sora)] text-[14px] text-white">
      Sent to GTBank •••• 6789. It usually lands within minutes.
    </div>
  </div>
</StepCard>
```

(Reuses `step1-caption-wallet-icon.svg` for the caption icon since the real icon for this card wasn't exported — swap once Trust/FAQ/Footer/mobile's follow-up plan revisits this card with real Figma data.)

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

In-browser: confirm the third card renders and roughly matches the earlier screenshot (payout currency row, account number/bank row, confirmation strip).

- [ ] **Step 3: Commit**

```bash
git add src/components/landing/HowItWorks.tsx
git commit -m "feat(landing): naira-lands-in-bank step card (approximated pending Figma quota)"
```

---

### Task 10: Full-page review and finish

**Files:** none (verification only)

- [ ] **Step 1: Full verification**

```bash
npx tsc --noEmit
npm test
rm -rf .next && npm run build
```
Expected: all three clean/passing.

- [ ] **Step 2: Full-page browser check**

Start the dev server, open `/` in the Chrome extension tools, and check:
- Nav renders, links scroll to their in-page anchors (`#how-it-works` at minimum — `#security`/`#faq`/`#support` will 404-scroll harmlessly until Trust/FAQ/Footer exist; that's expected and fine for this plan's scope)
- "Connect Wallet" opens the real Stellar Wallets Kit modal and reflects connected state
- Hero, Stats strip, and all three How It Works cards render with real assets, no broken images
- `/app` still renders the full dashboard exactly as before this plan started

- [ ] **Step 3: Finish the branch**

Use the `finishing-a-development-branch` skill: verify tests, present the merge/PR/keep-as-is menu, and follow whichever option is chosen.
