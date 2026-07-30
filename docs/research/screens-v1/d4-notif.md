# Notification Center — the findings inbox as a right-hand second sidebar

## 1. Concept + thesis

**Notification Center.** Everyone on this team already clears an inbox forty times a day: the
one on their phone. That interaction model is free — grouped by kind, newest on top, a soft
badge on the bell, tap to expand in place, swipe-sized buttons underneath, "You're all caught
up" at the bottom. So I am not inventing an attribution-findings UI; I am shipping the
notification center they already know, docked to the right of the waterfall. Right side,
because notifications live on the right on every OS these people touch and because the left
sidebar is *navigation* — mixing "where am I going" with "what needs me" is the one thing
that would force a tour. Findings are few (0–4) and stakes are high, so each row gets a
generous, thumb-sized target, one plain-language headline, one monospace evidence line, and
one place to go. No table, no density toggle, no filter chips. If a first-time user has to
ask what a control does, I designed it wrong.

## 2. ASCII layout sketch (desktop, ≥1280px)

```
┌──────────┬──────────────────────────────────────────────┬─────────────────────────────┐
│ LEFT NAV │ TOPBAR  Attribution · Shopify 12m · Meta 3h  🔔②│  (bell toggles panel)     │
│          ├──────────────────────────────────────────────┼─────────────────────────────┤
│ Dashboard│                                              │ FINDINGS              ⌄ ✕  │ ← panel header
│ MER      │   Yesterday · $6,820 net sales                │ 2 need attention           │
│ ▸Attribu.│   ┌────────────────────────────────────────┐  ├─────────────────────────────┤
│ Creatives│   │  WATERFALL — 7 buckets, sums exactly   │  │ NEEDS ATTENTION            │ ← group header
│ Imports  │   │  Meta 3,180 · Google 720 · Klaviyo 540 │  │ ┌─────────────────────────┐ │
│ Teams    │   │  TikTok 95 · Organic 1,245 …           │  │ │🔴 Meta claims 2.1× what │ │
│ Accounts │   └────────────────────────────────────────┘  │ │   Shopify verifies      │ │
│ Studio   │                                              │ │   3 days running        │ │
│          │   Claimed $6,200  ·  Verified $2,940          │ │   6,200 vs 2,940 · 2.1× │ │ ← mono
│          │   Verified ROAS 1.63 (target 1.50)            │ │   Claimed vs verified → │ │
│          │   3 orders pending attribution                │ │  ── expanded ──────────  │ │
│          │                                              │ │  [Mute 7d] [Resolve]    │ │
│          │                                              │ └─────────────────────────┘ │
│          │                                              │ │🟡 Broken UTM template   │ │
│          │                                              │ │   7 orders · unreadable │ │
│          │                                              │                             │
│          │                                              │ EARLIER                     │
│          │                                              │ ✓ Unattributed spike        │
│          │                                              │   resolved Tue 09:12        │
│          │                                              │ ─────────────────────────── │
│          │                                              │ Muted (1) ⌄   History →     │ ← footer
└──────────┴──────────────────────────────────────────────┴─────────────────────────────┘
                                                            360px, sticky, own scroll
```

Panel is a sibling of main content (flex row), not an overlay: content reflows to 
`calc(100% - 360px)` when open. Collapsed = 0px, and the bell in the topbar keeps the badge.

## 3. Anatomy

**Panel regions, top to bottom**
- **Header** — "Findings" + one-line subhead that speaks the state in plain words: *"2 need
  attention"* / *"All clear"* / *"Numbers may be stale"*. Collapse chevron and ✕ at right.
- **Group: NEEDS ATTENTION** — active findings, criticals first, then warnings, then newest.
- **Group: EARLIER** — up to 3 findings resolved in the last 7 days, dimmed, ✓ leading.
- **Footer** — `Muted (n) ⌄` disclosure and `History →` link. Always visible, sticky.

**Finding row (the notification)** — a rounded 12px card, 12px gap between cards, generous
16px padding, 44px minimum touch target on every control:
1. **Status dot** — 8px filled circle, leading. Red = critical, amber = warning, grey ✓ =
   resolved. Color is never the only signal; the dot pairs with position in a group.
2. **Headline** — the rule's plain sentence, 15px/1.35, medium weight, wraps to 2 lines max,
   no truncation of the number that matters. Sentence case, never SHOUTING severity labels.
3. **Evidence line** — monospace 12px, muted foreground: `$6,200 claimed · $2,940 verified ·
   2.1×`. Frozen at detection time; it never re-renders as data moves under it.
4. **Timestamp** — 12px muted, right-aligned on the evidence row: `3 days running`, `2h ago`.
5. **Destination link** — one, styled as a text link with trailing →: *Claimed vs verified →*.
6. **Actions** — hidden until the row is expanded, then a single row of secondary buttons:
   `Mute 7 days` · `Mark resolved` · (`Rerun sync` on sync findings only).

Collapsed rows show 1–5. Expanding reveals 6 and nothing else — there is no detail body,
because the evidence surface is the detail. One finding expanded at a time (accordion).

## 4. Interaction

- **Open/close** — bell icon in the topbar toggles the panel; badge shows active count (red
  dot only, no number, when the count is 1 — a number for 2+). Panel state persists per user
  in localStorage. Default: open on the Attribution route, closed everywhere else.
- **Read** — click anywhere on a card to expand; clicking another card collapses the first.
  Clicking the destination link navigates main content and *leaves the panel open and the
  card expanded*, so the user can read the evidence and act without losing their place.
- **Triage** — `Mark resolved` animates the card out of NEEDS ATTENTION and into EARLIER with
  a 4-second `Undo` in the card's place. `Mute 7 days` does the same with copy "Muted until
  Aug 6 · Undo". `Rerun sync` swaps the row's actions for an inline spinner + "Syncing…" and
  the row resolves itself or restates on completion. No confirmation dialogs anywhere.
- **Keyboard** — `⌘/Ctrl + \` toggles the panel. Inside: `↑ ↓` move between cards, `Enter`
  expands/collapses, `Enter` again on the focused link follows it, `M` mutes, `R` resolves,
  `Esc` collapses the card then closes the panel. Focus ring is the standard cyan ring; the
  panel is a labelled `<aside role="complementary" aria-label="Findings">` and count changes
  announce via a polite live region ("2 findings need attention").
- **Badge** — counts active, unmuted findings only. Resolved and muted never badge. When a
  new finding arrives after a sync, its card slides in from the top with a 200ms fade and
  the badge bumps; no toast, no sound, no interruption of the waterfall.

## 5. States

- **All clear (0 findings)** — panel stays open, subhead reads *"All clear"*, and the body is
  a centered ✓ in a soft cyan circle with *"Nothing needs attention. Last checked 12 min ago
  after the Shopify sync."* The mention of the check is the point: emptiness has to read as
  *verified*, not as *nothing loaded*. EARLIER and the footer stay visible so recent wins are
  right there. Bell shows no badge.
- **Meta sync down** — a critical card pins to the top of NEEDS ATTENTION: *"Meta sync broken
  — claims missing 2 days"*, evidence `last claim 2026-07-28 · 2 days missing`, link *Sync
  health →*, actions `Rerun sync` · `Mute 7 days`. The Meta bucket in the waterfall reads
  "no data" and the card's evidence line says the same — never $0. Panel header subhead flips
  to *"Numbers may be stale"* and the topbar bell badge turns red.
- **Shopify sync down** — same card shape, headline *"Shopify sync broken — numbers current
  as of 08:00"*, and because the identity itself is unverifiable, the panel header gets a
  thin amber top border and the subhead reads *"Totals are from 08:00"*. This is the only
  time the panel decorates itself; it is the only time the whole page is suspect.
- **Mobile (<1024px)** — the panel is not a sidebar; it is the notification tray. The bell
  sits in the mobile topbar with its badge, and tapping it opens a bottom Sheet at 85vh with
  a drag handle — identical cards, identical grouping, full-width tap targets. Following a
  destination link dismisses the sheet. On tablet (1024–1280px) the panel becomes an overlay
  Sheet from the right rather than pushing content, so the waterfall never gets squeezed.

## 6. What I deliberately left out

- **Filters, search, sort, severity tabs.** At 0–4 items, every control is more work than
  reading the list. Chrome would make a quiet inbox look busy.
- **Swipe-to-dismiss on mobile.** It is the most familiar gesture I know and I still cut it:
  `Mark resolved` is a claim about a business fact, and an undoable-but-invisible gesture
  invites accidental resolution. Buttons only, everywhere.
- **Counts on group headers** ("NEEDS ATTENTION (2)"). The subhead already says it once;
  saying it twice is dashboard-speak.
- **Unread state.** Findings are not messages — a finding is either active or it isn't.
  Read/unread would add a state the user has to maintain for no decision.
- **A full history view inside the panel.** The footer's `History →` goes to a page. Panels
  are for what's live; archives deserve a URL you can share.
- **Assigning findings to people.** The brief is explicit and I agree: actions route to
  surfaces. Adding an owner field turns an inbox into a ticketing system overnight.

## 7. Build notes (~1 week)

- **Panel shell** — a second `SidebarProvider` from shadcn `sidebar` with `side="right"`,
  `collapsible="offcanvas"`, width var overridden to `360px`; it already gives keyboard
  toggle, persistence cookie, and mobile Sheet fallback. Reuse rather than hand-roll.
- **Cards** — plain `div` + Tailwind (`rounded-xl border bg-card p-4`), not `Card`, to keep
  padding under our control. Expansion via Radix `Accordion` (`type="single" collapsible`)
  so keyboard and ARIA come free.
- **Badge** — shadcn `Badge` in the topbar bell button; count from the same tRPC query the
  panel uses, so they can never disagree.
- **Undo** — `sonner` toast is wrong here (it covers content); render the undo strip in the
  card's own slot with a 4s `setTimeout`, cancelled on click.
- **Evidence type** — `font-mono text-xs text-muted-foreground tabular-nums`.
- **Data** — one `findings.list` tRPC query returning `{active, resolved, muted}`, invalidated
  after any sync mutation. `Rerun sync` calls the existing Meta/Shopify sync mutation.
- **Week plan** — d1 panel shell + responsive fallbacks; d2 card anatomy + all 4 states with
  fixtures; d3 expand/actions/undo; d4 keyboard + a11y pass + live region; d5 wire tRPC,
  dark theme check, empty-state copy review.
