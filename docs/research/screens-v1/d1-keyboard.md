# The Queue — findings inbox as a right-rail triage strip

## 1. Concept + thesis

**The Queue.** The findings panel is a right-hand rail, 360px, that behaves like a mail queue and
nothing else: rows are keyboard rows, every action is one keystroke, the count in the header is the
number of decisions the operator still owes the data. It goes on the RIGHT because the left sidebar
is navigation (where am I) and the right rail is work (what do I owe) — and because the hands are
already on `j`/`k` over there, never crossing the viewport. It never becomes a page section,
because a section scrolls away and a scrolled-away queue is an unread count you learn to ignore.
Findings expand IN PLACE, pushing nothing: the waterfall stays pixel-stable while you triage, so
the number a finding cites is still on screen next to the finding citing it. 0–4 items a day means
this panel is empty most mornings, and empty must be the loudest state in the app — an emptied
queue is the product working, not a blank slate to decorate. No illustration. A timestamp.

## 2. ASCII layout (desktop, ≥1280px)

```
┌────────────┬──────────────────────────────────────────────┬──────────────────────────┐
│ LEFT NAV   │ TOPBAR: Attribution · Shopify 12m · Meta 3h  │ QUEUE HEADER             │
│ (existing) ├──────────────────────────────────────────────┤ Findings  2   ⌥F  [»]    │
│            │                                              ├──────────────────────────┤
│ Dashboard  │  IDENTITY STRIP                              │ ▸ ● CRITICAL        2d   │◀ selected
│ MER        │  Shopify net sales $6,820 = 7 buckets        │   Meta claims 2.1× what  │  (cyan
│ Attribution│                                              │   Shopify verifies       │   left
│ Creatives  │  WATERFALL                                   │   6,200 clm/2,940 vfd    │   bar)
│ Imports    │  Meta      ████████████  $3,180              │   Claimed vs verified →  │
│ Teams      │  Google    ███           $720                ├──────────────────────────┤
│ Accounts   │  Klaviyo   ██            $540                │ ▸ ▲ WARNING         6h   │
│ Studio     │  TikTok    ▌             $95                 │   Broken UTM template    │
│            │  Organic   █████         $1,245              │   7 orders unreadable    │
│            │  Unattrib. ██            $610                ├──────────────────────────┤
│            │  Untracked █▌            $430                │                          │
│            │                                              │   (empty rows: nothing)  │
│            │  CLAIMED vs VERIFIED · ROAS 1.63 / tgt 1.50  │                          │
│            │  3 orders pending attribution                ├──────────────────────────┤
│            │                                              │ Resolved (4) · Muted (1) │◀ footer
└────────────┴──────────────────────────────────────────────┴──────────────────────────┘
```

Collapsed: rail becomes a 44px gutter — vertical `FINDINGS`, count pill, severity dots stacked.
`⌥F` toggles. Collapse state persists per user. Never auto-collapses; never auto-opens.

## 3. Anatomy

**Panel regions (top→bottom, fixed header/footer, scroll only the list):**
- **Header** — `Findings` + count pill (cyan = warnings only, red = any critical, grey `0`), hint
  `⌥F`, collapse chevron. Header is sticky and is the only chrome.
- **List** — rows, 1px warm-grey dividers, no cards, no shadows, no padding luxury.
- **Footer** — one line, two links: `Resolved (4)` · `Muted (1)`. History is NOT in the rail; both
  open a Sheet over the main content with a plain reverse-chronological table.

**Finding row (collapsed, 3 lines, 12px vertical padding, whole row is the hit target):**
1. `▸` disclosure · severity glyph+label (`● CRITICAL` red / `▲ WARNING` amber) · right-aligned
   age (`2d`, `6h`, tabular-nums, muted). Severity is text, not color alone.
2. Title, 14px/500, two lines max, no truncation mid-word.
3. Frozen numbers, `font-mono` 12px, muted: `6,200 clm / 2,940 vfd · 3d`. Never recomputed.

Selected row: 2px cyan left bar + `bg-accent`. Focus ring only when focus arrived via keyboard.

**Row expanded (in place, pushes rows below, height animates 120ms):** adds the rule sentence in
plain language ("claims exceed 2× verified for 3 consecutive days"), the evidence deep-link as a
real link (`Claimed vs verified →`), and an action row of three small buttons with underlined
mnemonics: `Mute 7d (m)` · `Resolve (e)` · `Rerun sync (r)` — `r` present only on sync findings.
One finding open at a time; opening the next closes the last.

## 4. Interaction

- `⌥F` focus/toggle rail. `j`/`k` move selection (wraps stop at ends, no cycling). `Enter`/`→`
  expand, `Esc`/`←` collapse then release focus to main. `o` open the evidence link (same tab —
  triage means going and looking; browser back returns with the row still selected and expanded).
- `m` mute 7 days · `e` mark resolved · `r` rerun sync. All three fire from the collapsed row too:
  selection alone is enough context, no expand required to act. Each shows an inline undo strip in
  the vacated row slot for 6s (`Muted · Undo (u)`) before the row leaves. Actions are optimistic;
  a failure restores the row and stamps it `action failed · retry (r)`.
- After a row leaves, selection lands on the next row down — the queue drains under the cursor.
- Count = active findings only, muted and resolved excluded. It is a decision count, so it never
  shows a badge for something you cannot act on, and there is no "new" vs "unread" distinction:
  a finding either needs a decision or it is gone.
- Mouse users get identical affordances: click row to expand, buttons visible on expand, hover
  reveals nothing that keyboard cannot reach. Zero hover-only actions.
- No bulk select, no multi-select. Four items a day. `j e j e` is faster than a checkbox column.

## 5. States

- **Healthy (2 findings)** — as sketched. Critical first, then warning, then by age. Fixed rule
  order breaks ties, so the list never reshuffles between syncs.
- **All clear** — header count is a grey `0`. List shows two lines, left-aligned, no icon, no
  illustration: `Queue empty` / `Last checked 12 min ago · 5 rules ran`. Rail stays open at full
  width. The earned feeling comes from the audit line, not a graphic.
- **Meta sync down** — a `● CRITICAL` row pinned to the top: `Meta sync broken — claims missing
  2 days`, mono line `last claim 2026-07-28 · 2 rules could not run`, link `Sync health →`,
  actions `Rerun sync (r)` · `Mute 7d (m)` (no resolve — you don't resolve a broken pipe). Rules
  that depend on Meta render below as a single muted line: `2 rules paused — no data`. Waterfall's
  Meta bucket reads `no data`, and the identity strip says `identity unavailable`, never `$0`.
- **Shopify sync down** — same pinned critical (`numbers current as of 08:00`), plus the rail
  header gains a one-line amber strip: `Numbers frozen 08:00`. Every other finding in the list is
  dimmed to 60% with a mono suffix `· stale`, and `e`/`m` are disabled on them with the reason
  inline — you cannot resolve a finding computed from numbers that stopped moving.
- **Mobile / <1024px** — the rail is not a rail. Topbar gets a `Findings 2` button with the same
  severity coloring; it opens a full-height Sheet from the right containing the identical list and
  rows. Expand still happens in place. No keyboard model on mobile, no phantom shortcuts shown.
  Between 1024–1280px the rail overlays the content instead of shrinking the waterfall.

## 6. Deliberately left out

- **Filters, search, sort controls.** Five rules, four items. Chrome for a queue this short is
  pure latency.
- **Severity color as the only signal, and any severity beyond CRITICAL/WARNING.** Two levels map
  to two behaviors: act now, act today. A third level is a level nobody acts on.
- **Assignment, comments, @mentions.** Actions route to surfaces, not people — per the brief, and
  because a comment thread is where a finding goes to die.
- **Toasts.** Undo lives in the row that vacated. A toast makes the eye leave the queue.
- **Unread state, badge on the left nav, notification dots.** A finding is a decision, not a
  message. Duplicating the count in nav teaches people to dismiss both.
- **Auto-open on new critical.** It steals focus mid-keystroke. The count going red is enough.
- **In-panel charts or sparklines.** The waterfall is 8px away and stays on screen. The panel's
  job is frozen numbers and a link.

## 7. Build notes (~1 week)

- Rail: extend the existing shadcn `sidebar` primitive with a second `SidebarProvider` (side
  `right`, `collapsible="icon"`, own cookie key) — reuses collapse/persist/mobile-Sheet behavior
  for free, and the mobile fallback is the same component with no extra work.
- Rows: plain `div`s in a `role="listbox"` / `role="option"` list, not `Accordion` — we need
  arbitrary keys and a single-open invariant. Expand via `Collapsible` inside the row.
- Keyboard: one `useEffect` key handler scoped to the rail's roving-tabindex container, plus a
  global `⌥F` in the existing shortcut registry. Selection index in `useState`; no library.
- Actions: three tRPC mutations on a `findings` router (`mute`, `resolve`, `rerunSync`) with
  optimistic cache updates; undo is a 6s client-side timer that cancels before commit.
- History: one `Sheet` + `Table` for Resolved/Muted, tab-switched, no pagination at this volume.
- Type: `font-mono` + `tabular-nums` for every frozen number and every age; Figtree elsewhere.
- Budget: d1–d2 rail shell + rows + states, d3 expand/actions/undo, d4 keyboard + a11y, d5 the
  four app states incl. `no data` propagation, history Sheet, dark theme pass.
