# THE TAPE — attribution findings as a right-hand instrument rail

## 1. Concept + thesis

**THE TAPE.** A fixed 340px right-hand rail, monospace throughout, that never collapses to an
icon and never hides a number behind a click. A findings inbox that reads like an inbox is a
notification tray: it teaches you to clear it and look away. The identity on this page — $6,820
decomposing into seven buckets, exactly — is a *live instrument reading*, and the findings are
the annunciator panel next to the gauge. So the rail is always mounted, always showing the two
sync clocks at its top and the last-run timestamp at its bottom, and every finding carries its
frozen figures on the face of the row: claimed 6,200 vs verified 2,940, ratio 2.11×, day 3 of 3.
You should be able to read the whole state of the account from the rail without touching it. It
sits on the right because the left sidebar is *navigation* (where am I) and the tape is *status*
(what is true right now) — mixing those two is how you end up clicking through a tree to find
out your data is stale. Rows expand in place, pushing the rows below down; nothing overlays the
waterfall, because the number you are checking the finding against must stay visible while you
read the finding. All clear is not an empty state — it is a **green tape**: five rule names, each
with its current measured value and its threshold, all passing. That is what makes clear feel
earned. You didn't get silence; you got five readings.

## 2. ASCII layout — desktop ≥1280px

```
┌────────────┬──────────────────────────────────────────────┬──────────────────────────────┐
│ LEFT NAV   │ TOPBAR  Attribution · Shopify 12m · Meta 3h  │ RAIL HEADER                  │
│ (existing) ├──────────────────────────────────────────────┤ FINDINGS 2   ● 1 CRIT ● 1 WRN│
│            │                                              │ SHOPIFY ●12m  META ●3h04m    │
│ Dashboard  │  IDENTITY                                    ├──────────────────────────────┤
│ MER        │  Shopify net sales, yesterday   $6,820.00    │ ROW 1 (expanded)             │
│ ▸Attributn │  ───────────────────────────────────────────  │ ┌──────────────────────────┐ │
│ Creatives  │  Meta            3,180.00  ████████▊  46.6%  │ │CRIT 03:15  R1 CLAIM_RATIO│ │
│ Imports    │  Google            720.00  ██▏       10.6%   │ │Meta claims 2.11× verified│ │
│ Teams      │  Klaviyo           540.00  █▋         7.9%   │ │clm 6,200 vrf 2,940 d3/3  │ │
│ Accounts   │  TikTok             95.00  ▎          1.4%   │ │ thr 2.00×  Δ +0.11       │ │
│ Studio     │  Organic/direct  1,245.00  ███▌      18.3%   │ │ d-1 2.11 d-2 2.04 d-3 2.09│ │
│            │  Unattributed      610.00  █▊         8.9%   │ │ Claimed vs verified →    │ │
│            │  Untracked         430.00  █▎         6.3%   │ │ [Mute 7d] [Resolve]      │ │
│            │  ───────────────────────────────────────────  │ └──────────────────────────┘ │
│            │  IDENTITY OK   Σ 6,820.00 = 6,820.00   Δ 0.00│ ROW 2 (collapsed)            │
│            │                                              │ WARN 03:15 R2 UTM_UNMATCHED  │
│            │  META CHECK                                  │ Broken UTM template          │
│            │  claimed 6,200.00  verified 2,940.00  2.11×  │ 7 ord  thr ≥5  $412.00       │
│            │  vROAS 1.63  target 1.50  Δ +0.13           ├──────────────────────────────┤
│            │  3 orders pending attribution               │ RULE TAPE (always visible)   │
│            │                                              │ R1 2.11× /2.00  FAIL         │
│            │                                              │ R2 7 /5        FAIL          │
│            │                                              │ R3 8.9% /15.0% pass          │
│            │                                              │ R4 1.63 /1.50  pass          │
│            │                                              │ R5 syncs 2/2   pass          │
│            │                                              ├──────────────────────────────┤
│            │                                              │ FOOTER  rules ran 03:15 ICT  │
│            │                                              │ muted 1 · resolved 14 ▸      │
└────────────┴──────────────────────────────────────────────┴──────────────────────────────┘
```

## 3. Anatomy

**Rail:** fixed 340px, own scroll container, right edge of viewport, full height under topbar,
1px warm-grey border-left, background one step off page (`bg-muted/40`). Never collapses on
desktop. Four regions, top to bottom:

1. **Header (sticky, 3 lines).** Line 1: `FINDINGS 2` + severity pips `● 1 CRIT ● 1 WARN` (red /
   amber, cyan when zero). Line 2–3: two sync clocks, each `LABEL ● age` — dot green <60m, amber
   <6h, red = broken. Ages are live-ticking (30s interval), monospace tabular, so the rail is
   also the sync console. Clicking a clock jumps to Sync health.
2. **Findings stack**, severity then recency. No section headers, no tabs.
3. **Rule tape** — all 5 rules, one line each, permanently: `Rn  measured /threshold  PASS|FAIL`.
   Fails are dimmed-red text (the loud version lives above); passes are muted grey.
4. **Footer (sticky).** `rules ran HH:MM ICT` · `muted N · resolved N ▸` — the ▸ opens history.

**Collapsed row (4 lines, 12px mono, no card chrome, 1px top rule):**
- L1: `SEV  HH:MM  Rn  RULE_ID` — severity as uppercase text swatch (red/amber bg, black text,
  2px pad), time frozen at rule-run, rule number, `SCREAMING_SNAKE` rule id.
- L2: title, sentence case, one line, truncate with title attr. 13px, medium weight.
- L3: the frozen figures, tabular-nums: `clm 6,200 vrf 2,940 d3/3` or `7 ord thr ≥5 $412.00`.
- L4 appears only on hover/focus: the deep link, cyan, `Claimed vs verified →`.

**Expanded row adds:** threshold line (`thr 2.00× Δ +0.11`), a 3-day sparkline-as-text
(`d-1 2.11 d-2 2.04 d-3 2.09`), the deep link pinned visible, and the action row —
`[Mute 7d] [Resolve]`, plus `[Rerun sync]` for R5 only. Ghost buttons, mono, 24px tall.
Never `$0`: a broken sync prints `no data` in place of every figure, same column positions.

## 4. Interaction

- **Open:** click row or `Enter` → expands in place, pushes rows below down, 120ms height
  transition. One row expanded at a time (accordion); collapsing is instant. Main content never
  moves, never dims, never gets overlaid — you read the finding against the live waterfall.
- **Deep link:** click the `→` link navigates main content only; the rail stays, the row stays
  expanded, and the row gets a cyan left border marking "this is what you're looking at."
- **Triage:** `Mute 7d` → row collapses to a single strikethrough line for 4s with `[Undo]`, then
  leaves; count decrements; the rule's tape line gains `MUTED 7d` and keeps showing its live
  measured value, because muting an alert must not blind the instrument. `Resolve` → same
  pattern, lands in history. `Rerun sync` → row locks, clock dot pulses, `SYNCING…` replaces the
  age, resolves to a new age or to `FAILED HH:MM`.
- **Keyboard:** `g i` focuses the rail; `j`/`k` move between rows; `Enter` expand/collapse;
  `o` follow deep link; `m` mute; `r` resolve; `Esc` collapse and return focus to main. Focus
  ring is a 2px cyan outline on the whole row. Roving tabindex, `role="list"`.
- **Counts:** header count = active unmuted findings. It is a count, not a bell — no unread
  state, no dot that clears on view, no toast. The number is either right or it's zero. A count
  change animates the digit only (100ms), never the container.

## 5. States

- **Healthy (2 findings):** as sketched. Header `FINDINGS 2`, tape shows 2 FAIL / 3 pass.
- **All clear:** header goes `FINDINGS 0` with a cyan pip and `ALL RULES PASSING`. Findings stack
  is replaced by a single line — `no active findings · last 03:15 ICT` — and the rule tape gets
  visual promotion: full 5 lines, brighter, each `measured /threshold pass` with its 3-day text
  sparkline. Earned, because you're staring at five green readings, not an empty box.
- **Meta sync down:** Meta clock red, `META ● BROKEN 2d 04h`. A CRIT row pins to the top of the
  stack, expanded by default: `Meta sync broken — claims missing 2 days`, figures `clm no data
  vrf 2,940 ratio no data`, `Sync health →`, actions `[Rerun sync] [Mute 7d]`. Rule tape R1 shows
  `no data /2.00 STALE`. Main content's Meta bucket and claimed figure print `no data`; the
  identity still balances on Shopify's side and still says `IDENTITY OK`.
- **Shopify sync down:** the worse one. Shopify clock red `SHOPIFY ● BROKEN as of 08:00`; pinned
  CRIT `Shopify sync broken — numbers current as of 08:00`. Because the identity's total is
  unknown, the rail dims the entire rule tape to `STALE` (no rule can be evaluated against a
  missing denominator) and the header reads `FINDINGS 1 · TAPE STALE`. Only `[Rerun sync]` is
  offered — no mute on a broken source of truth.
- **Mobile / <1024px:** the rail becomes a bottom sheet with a **persistent 44px peek bar** that
  is always on screen above the tab bar: `● 1 CRIT ● 1 WRN   SHOP ●12m  META ●3h`. Drag or tap to
  a 70vh sheet with the same four regions, same rows, same tape. Still a second sidebar — same
  content, same always-visible readings, rotated 90°. It never becomes a bell icon.

## 6. Deliberately left out

- **Collapse-to-icon on desktop.** A rail you can hide is a rail that is hidden, and then the
  sync clocks aren't doing their job. 340px is affordable; the waterfall needs ~700px.
- **Tabs / filters / search.** 0–4 findings. Chrome for navigating four rows is an insult.
- **Toasts, bells, unread dots, badge-clearing.** Persistent truth, not interruption. Nothing in
  this rail is "seen."
- **Assignment, comments, @mentions.** Actions route to surfaces. There are no people here.
- **Severity icons and illustrated empty states.** Uppercase text swatches read faster at 12px
  and don't invent a second color language. All clear earns numbers, not a checkmark drawing.
- **Popovers and modals for expansion.** Any overlay covers the figure you're verifying against.
- **Relative-only timestamps.** Every finding carries a frozen `HH:MM ICT`; ages tick only for
  syncs, where recency *is* the measurement.

## 7. Build notes (~1 week)

- **Shell:** shadcn `SidebarProvider` already wraps the app; add a second `Sidebar side="right"`
  with `collapsible="none"` scoped to the attribution route via a layout slot. Grid:
  `grid-cols-[var(--sidebar-w)_minmax(0,1fr)_340px]`.
- **Type:** one Tailwind utility, `font-mono tabular-nums text-xs leading-[1.45]`, on the rail
  root; sizes 11/12/13px only. Add `--font-mono` (JetBrains Mono or Geist Mono) alongside Figtree.
- **Rows:** hand-rolled `<li>` + `Collapsible` for expansion (accordion state held in the parent,
  not `Accordion` — we need programmatic j/k control). Buttons: `Button size="sm" variant="ghost"`.
- **Sparklines:** text, not SVG. Zero deps.
- **Clocks:** one `useSyncClocks()` hook, 30s `setInterval`, formats age + dot color from the
  same freshness thresholds the topbar caption uses — share that helper, don't fork it.
- **Data:** one tRPC `attribution.findings.list` returning `{findings[], rules[], syncs{}}` so the
  tape and clocks come from the same payload as the rows and can never disagree. Mute writes a
  per-rule `mutedUntil`; resolve writes a history row. `attribution.findings.history.list` for ▸.
- **Mobile:** shadcn `Drawer` (vaul) with `snapPoints={[0.11, 0.7]}`, first snap = the peek bar.
- **Keyboard:** `react-hotkeys-hook`, scoped to the rail; roving tabindex by hand.
- **Budget:** d1–2 shell + grid + type scale; d3 row anatomy + expansion; d4 rule tape + clocks +
  tRPC; d5 actions/undo/rerun; d6 four states + `no data` audit; d7 mobile drawer + keyboard + a11y.
