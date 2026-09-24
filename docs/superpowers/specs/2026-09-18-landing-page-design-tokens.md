# Landing Page — Design Tokens Reference

> **INCOMPLETE — Figma MCP rate limit hit.** This session hit the Figma MCP
> "Starter plan" tool-call limit partway through (confirmed hard, not a
> transient burst — retried once after 15s, same error). Covered:
> **Hero**, **Stats strip**, **How It Works heading**, and step cards
> **1 (Connect wallet)** and **2 (FX lock)**. NOT covered: step card 3
> (Naira lands in bank), **Trust section**, **FAQ**, **Footer**, and the
> entire **mobile** pass (390px frame) for every section. Someone must
> either upgrade the Figma plan or wait for the limit to reset, then repeat
> this same process — call `get_design_context` (with `figma-design-to-code`
> skill loaded) on the remaining nodes listed in the parent spec
> (`2026-09-18-landing-page-design.md`) — before the implementation plan can
> cover those sections and mobile breakpoints with real values instead of
> guesses.

## Colors

| Hex / rgba | Used for | Section(s) |
|---|---|---|
| `#131212` | Hero section background | Hero |
| `#121212` | Data/stats screen background | Stats strip |
| `#c9a962` | Accent gold — logo "$", hero headline text | Hero |
| `rgba(255,255,255,0.1)` | Nav pill background; step-card background; step-card inner-row background | Hero, How It Works |
| `rgba(201,169,98,0.2)` | Nav "Connect Wallet" pill background | Hero |
| `rgba(201,169,98,0.6)` | Hero "Convert USDC Now" button background | Hero |
| `#ffffff` (`text-white`) | Nav links, nav button label, hero CTA label, stat numbers, step-card wallet names, step-card "connect"/FX-lock labels, step captions | Hero, Stats, How It Works |
| `#fdf8f8` | Hero subtext | Hero |
| `#d0cccc` | Stat captions ("Settled to Nigerian banks", etc.) | Stats strip |
| `#f3f3f3` | Chain-logo circle background (the 5 middle logos, not the first or last) | Stats strip |
| `#a9a5a5` | "How it works" section subtext | How It Works |
| `#484747` | Small pill/tab marker border next to "How it works" heading | How It Works |
| `#aba8a8` | Step-card description body text | How It Works |

No Figma variables/styles are defined for this frame (`get_variable_defs`
returned empty) — every value above is a raw literal in the file, not a
token reference.

## Typography

Two display/body font families recur everywhere seen so far:

- **Fraunces** (serif, variable font with axes `"SOFT" 0, "WONK" 1` applied
  via inline `fontVariationSettings` — not just a static weight) — used for
  every headline/number/card-title. Must load this exact variable font and
  apply those axis values, not just any Fraunces weight.
- **Sora** — used for body copy, nav links, captions, buttons.
- **Inter** — used narrowly: the "ETTU" wordmark base weight, and the
  "connect" label inside step-card wallet rows (`Inter:Semi_Bold`).

| Style name | Font | Size | Weight | Line-height | Color | Where |
|---|---|---|---|---|---|---|
| Logo mark | Inter | 24px | Semibold (`$`) / Regular (`ETTU`) | normal | `#c9a962` (`$`) / white | Nav logo |
| Nav link | Sora | 18px | Regular | normal | white | Nav links |
| Nav button label | Sora | 16px | Regular | normal | white | Nav "Connect Wallet", hero CTA |
| Hero H1 | Fraunces | 50px | Regular, uppercase | normal | `#c9a962` | Hero headline |
| Hero subtext | Fraunces | 20px | Regular | 26px | `#fdf8f8` | Hero subtext |
| Stat number | Fraunces | 50px | Regular | normal | white | Stats strip |
| Stat caption | Sora | 18px | Regular | normal | `#d0cccc` | Stats strip |
| Section heading | Fraunces | 30px | Regular | normal | white | "How it works" heading |
| Section subtext | Sora | 16px | Regular | normal | `#a9a5a5` | "How it works" subtext |
| Card wallet name | Fraunces | 20px | Regular | normal | white | Step 1 card ("Stellar", "Metamask") |
| Card wallet sublabel | Sora | 16px | Regular | normal | white | Step 1 card ("wallet") |
| Card action label | Inter | 20px | Semibold | normal | white | Step 1 card ("connect") |
| Card FX value | Sora | 14px | Semibold | normal | white | Step 2 card ("1380/USDC") |
| Card caption title | Fraunces | 20px | Regular | normal | white | Step 1 & 2 captions ("Connect wallet", "Your rate locks instantly") |
| Card caption body | Sora | 14px | Regular | 24px | `#aba8a8` | Step 1 & 2 descriptions |

Mobile sizes for all of the above: **not yet captured** (blocked by rate
limit — see banner).

## Spacing & Layout (desktop only — mobile blocked)

**Nav** (`654:8056`): pill width `890px`, padding `20px 10px` (wait: code
shows `px-[20px] py-[10px]`), border-radius `40px`, positioned
`top-[20px]` centered. Logo block width `120px`, padding `10px`. Nav-links
gap `50px`. "Connect Wallet" pill padding `16px`, border-radius `40px`.

**Hero content** (`654:8057`): column, width `765px`, centered
(`left-1/2` + `-translate-x-1/2`), positioned `top-[112px]`. Hero
illustration image `417×264px`. Inner "hero context" gap `34px`. "hero
text" block gap `19px` (between headline and subtext). CTA button: height
`60px`, padding `16px`, border-radius `40px`.

**Stats/data screen** (`654:8066`): section padding `100px` all sides, column
gap `50px` between the stats row and the logo row. Stats row: gap `136px`
between each stat block, each stat block `219px` wide, internal gap `9px`
(number → caption). Logo row: gap `59px` between logos, each logo circle
`56px` (icon inside `30px`, centered via `10px` padding).

**How It Works heading** (`656:8818`): column gap `20px` (marker+heading row
→ subtext). Heading row gap `10px` (marker → text). Marker: `28×13px`,
border `1px solid #484747`, border-radius `10px`.

**Step cards** (`654:8102` / `654:8125`, likely `654:8141` matches): each
card `362×483px` (from earlier metadata), border-radius `40px`, padding
`30px 50px` (px/py), background `rgba(255,255,255,0.1)`. Inner content gap
`50px` (top block group → caption block). Step 1's two wallet rows: each row
padding `10px`, border-radius `20px`, background `rgba(255,255,255,0.1)`,
gap `18px` between icon and text, icon circle `56px`. Caption block: gap
`20px` (icon+title row → body text), icon+title row gap `10px`, caption icon
`24px`.

Card-to-card gap and section-level vertical spacing around "How It Works" as
a whole: **not yet captured precisely** — the parent frame's own padding
wasn't in the fetched node; check `654:8098` (the row wrapper) if revisiting.

## Assets

All saved under `/tmp/claude-1000/-home-uche-ofatu-Desktop-stellaramp-next/4e825863-fed0-4bc8-b558-f32327bdc2dd/scratchpad/landing-assets/`. **These are ephemeral scratchpad files — before implementation, copy the ones actually used into the repo** (`public/landing/` per the parent spec) since the scratchpad is session-local.

| Asset | Figma node | Saved as | Used in |
|---|---|---|---|
| Coins + bank hero illustration | `654:8058` | `hero-illustration.png` | Hero — **1.7MB, needs compression/resizing before commit**, way oversized for a 417×264 display box |
| Background grid lines | `654:8000` (`Group 17`) | `hero-bg-grid.svg` | Hero background |
| Light beam vector 1 of 3 | `654:8035` | `hero-lightbeam-1.svg` | Hero background (mix-blend-plus-lighter, rotated 18.49deg) |
| Light beam vector 2 of 3 | `654:8036` | `hero-lightbeam-2.svg` | Hero background (rotated 7.78deg) |
| Light beam vector 3 of 3 | `654:8037` | `hero-lightbeam-3.svg` | Hero background (rotated 1.71deg) |
| Glow ellipse (top-right) | `654:8038` | `hero-glow-ellipse.svg` | Hero background (rotated 34.05deg) |
| Floating dots pattern | `654:8039` | `hero-floating-dots.svg` | Hero background |
| Bottom radial glow blob | `654:8053` | `hero-bottom-glow.svg` | Hero background (bottom fade into stats section) |
| Chain logo 1 (Stellar-look swirl, filename said "Icon.png") | `654:8078` | `chain-logo-1-stellar.png` | Stats strip, also reused as step-1 card icon (`654:8105`) |
| Chain logo 2 (ETH diamond) | `654:8080` | `chain-logo-2-eth.png` | Stats strip |
| Chain logo 3 (blue square, filename said "base_icon") | `654:8082` | `chain-logo-3-base.png` | Stats strip |
| Chain logo 4 (filename said "arbitrum_icon", visually a C/Circle-like mark) | `654:8084` | `chain-logo-4-arbitrum.png` | Stats strip |
| Chain logo 5 (red "OP" mark, filename said "Token.png") | `654:8086` | `chain-logo-5-token.png` | Stats strip |
| Chain logo 6 (dark bars mark, filename said "solana_symbol.png") | `654:8088` | `chain-logo-6-solana.png` | Stats strip |
| Chain logo 7 (purple mark, filename said "Symbol.png") | `654:8089` | `chain-logo-7-symbol.png` | Stats strip |
| Left glow ellipse behind stats | `654:8090` | `stats-glow-left.svg` | Stats strip |
| Right glow ellipse behind stats (flipped) | `654:8091` | `stats-glow-right.svg` | Stats strip |
| Metamask fox icon | `654:8112`/`8113` | `step1-metamask-icon.png` | How It Works step 1 |
| Small wallet icon (caption) | `654:8121` | `step1-caption-wallet-icon.svg` | How It Works step 1 & 2 captions (same icon reused) |
| FX-lock icon (33px) | `654:8128` | `step2-fx-lock-icon.svg` | How It Works step 2 |

**⚠️ Figma's designer-given filenames for the chain logos are misleading and don't reliably match what's actually drawn** (e.g. a node named "solana_symbol.png" visually renders as a dark bars glyph, not the Solana logo; "arbitrum_icon.jpeg" doesn't look like Arbitrum's ring). **Before shipping, open each downloaded PNG and manually confirm/relabel which real chain/token it depicts** rather than trusting the Figma layer name — the spec's content inventory says "ETH, Base, Arbitrum, Solana, and two more generic token marks" but the visual-to-name mapping needs a human eye, not the Figma metadata.

**Not yet fetched** (blocked): step-3 card assets, trust-section connector
vector + any icons, FAQ expand/collapse icons, footer social icons
(LinkedIn/X), hamburger menu icon, and every mobile-frame asset (some mobile
assets may be identical files reused at a different size — can't confirm
without fetching).

## Per-section notes

- **Hero background** is layered CSS-position + `mix-blend-plus-lighter`
  vector/SVG images, not a single flat gradient — reproduce as absolutely-
  positioned layered elements (grid SVG behind, three rotated light-beam
  SVGs with `mix-blend-mode: plus-lighter`, one rotated glow ellipse, a dot
  pattern, and a bottom glow), not a single CSS `background` shorthand.
- **Fraunces variable font**: every heading/number uses
  `fontVariationSettings: '"SOFT" 0, "WONK" 1'` — this needs the actual
  variable-font file (not just a static weight cut) loaded via
  `next/font` or a `@font-face` with `font-variation-settings` support, or
  the "WONK" alternate-letterform character won't render correctly.
  Confirm Fraunces is available via Google Fonts variable axes before
  committing to `next/font/google`.
- **Chain logo row structure**: 7 total circles, not 6 as the parent spec's
  content inventory estimated — first and last are plain (no background
  fill), the middle five sit on an `#f3f3f3` white-ish circle backdrop.
  Update the parent spec's "row of six chain/token logos" to seven once
  this is confirmed against the actual final logo identities.
- **Step cards structure**: fixed `362×483px` boxes in a 3-up row on
  desktop (per earlier metadata, cards live in a `1240px`-wide row
  container) — likely `flex`/`grid` with explicit gap, not the browser
  auto-wrapping; exact row gap not yet captured (see Spacing note above).
- **Step 1 and Step 2 share the same caption-icon asset**
  (`step1-caption-wallet-icon.svg`) despite different card content above
  it — reuse the one file, don't re-export per card.
