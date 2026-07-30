# The Ledger — Adsolute findings inbox as a right-hand second sidebar

## 1. Concept & thesis

**The Ledger.** A narrow, quiet column on the right that reads like the margin notes of an
accountant, not the cockpit of a fighter jet. The waterfall on the left is the *account of
record*; the Ledger is the short list of things that don't tie out. It belongs on the right
because the eye finishes the identity first — $6,820 decomposing into seven buckets — and only
then looks up to see whether anyone objects. It is persistent because objections should be
visible while you work the numbers, and it is *narrow* (360px, fixed) because the honest
answer on most days is one line long. Nothing in the Ledger animates, polls, or counts up.
It changes when a sync finishes, and it says when that was. Red appears at most on a couple of
lines, and only for the two rules that earn it; everything else is set in ink on paper —
warm-grey type, one hairline rule per row. The proudest state is **"Everything ties out."**
That state gets the most typographic care in the whole product: it is not an empty state, it
is a receipt.

## 2. ASCII layout sketch (desktop, ≥1280px)

```
┌──────────┬──────────────────────────────────────────────────┬────────────────────────────┐
│ LEFT NAV │ TOPBAR  Attribution · Yesterday, 29 Jul          │  ← shared topbar spans     │
│          │ Shopify updated 12 min ago · Meta 3 hrs ago      │                            │
│ Dashboard├──────────────────────────────────────────────────┼────────────────────────────┤
│ MER      │                                                  │ LEDGER          [›]  ⌥\   │
│ ▸Attrib. │   Shopify net sales, yesterday                   │ 2 findings · after 06:12  │
│ Creatives│   $6,820                                         │ ───────────────────────── │
│ Imports  │                                                  │ │ Meta claims 2.1× what   │
│ Teams    │   ▇▇▇▇▇▇▇▇  Meta            $3,180               │ │ Shopify verifies        │
│ Accounts │   ▇▇        Google            $720               │ │ claims 6,200 / ver 2,940│
│ Studio   │   ▇▇        Klaviyo           $540               │ │ 3 days running          │
│          │   ▪         TikTok             $95               │ │ Claimed vs verified →   │
│          │   ▇▇▇       Organic/direct   $1,245              │ ───────────────────────── │
│          │   ▇▇        Unattributed       $610              │   Broken UTM template     │
│          │   ▇         Untracked          $430              │   7 orders, unreadable    │
│          │   ─────────────────────────────────────          │   tags · yesterday        │
│          │   Identity holds. 3 orders pending.              │   Unmatched orders →      │
│          │                                                  │ ───────────────────────── │
│          │   Meta claimed $6,200 · verified $2,940           │ Muted (1)  ·  History     │
│          │   Verified ROAS 1.63 · target 1.50               │                           │
└──────────┴──────────────────────────────────────────────────┴────────────────────────────┘
                                                     360px fixed ─┘  collapses to 44px rail
```

## 3. Anatomy

**Panel regions**, top to bottom:

- **Masthead** — the word `Ledger`, a collapse chevron, and the shortcut hint `⌥\`. No icon.
- **Dateline** — `2 findings · after 06:12 sync` in small caps-ish 12px warm grey. This is the
  count. There is no badge, no pill, no number in a circle. A sentence is enough.
- **Findings list** — 0–4 rows, separated by hairlines (`border-border/60`), never boxed.
- **Footer ledger line** — `Muted (1) · History`, two quiet text links, 12px.

**Finding row** (all rows same anatomy; severity changes one detail only):

| Field | Treatment |
|---|---|
| Severity mark | 2px left border on the row: `destructive` for critical, `border-foreground/25` for warning. No icon, no fill, no dot. |
| Headline | 14px/1.35 `font-medium`, up to two lines, no truncation. Written as a claim, not an alert: "Meta claims 2.1× what Shopify verifies". |
| Frozen numbers | 12px `font-mono tabular-nums text-muted-foreground` — `claims 6,200 / ver 2,940`. Frozen at detection; never re-read from live data. |
| Age | Same mono line, after a `·`: `3 days running` / `yesterday`. |
| Evidence link | 13px cyan text link with trailing `→`, exactly one per finding. |
| Actions | Hidden until row hover/focus, then a single `⋯` at row right → menu: Mute 7 days · Mark resolved · (Rerun sync). |

Ordering is fixed and boring: sync findings, then criticals, then warnings, then by age. It
does not re-sort while you read it.

## 4. Interaction

- **Reading is the default.** Rows show everything a finding *is* — headline, numbers, age,
  one link. There is no "open" state, no expand, no popover, no content push. If you want
  more, you take the one link and leave; the Ledger's job ends at the doorway.
- **Triage** is `⋯` → menu, or keyboard. Mute confirms inline by replacing the row with one
  line — `Muted until 5 Aug · Undo` — which persists for the session, then the row is gone.
  Mark resolved does the same with `Resolved · Undo`. Nothing slides or fades; rows just
  become their receipt.
- **Rerun sync** appears only on sync findings. It sets the row's mono line to
  `rerun requested 09:14` and disables itself. No spinner, no progress bar. The topbar
  freshness caption is the source of truth, and it updates when the sync actually lands.
- **Keyboard.** `⌥\` toggles the panel. `j`/`k` move focus between rows, `Enter` follows the
  evidence link, `m` mutes, `r` marks resolved, `Esc` returns focus to the waterfall. Focus
  rings are the shadcn default; nothing custom.
- **Count behavior.** The dateline sentence is the only count, and it is stamped with the sync
  that produced it. When collapsed to the 44px rail, the rail shows a vertical `2` in mono and
  — if any critical is present — one 2px cyan-free red tick at its top. That is the entire
  notification surface of the feature. No favicon badge, no toast, no nav-item dot.

## 5. States

- **All clear.** The list is replaced by a centered receipt: `Everything ties out.` at 16px
  medium, beneath it one mono line `$6,820 accounted, seven buckets, no exceptions`, beneath
  that `Checked after 06:12 sync · 5 rules`. Footer keeps `Muted (1) · History`. The panel
  stays open at full width — collapsing it on "all clear" would steal the moment.
- **Meta sync down.** One critical row pinned first: `Meta sync broken — claims missing 2
  days`, mono `last claims 27 Jul 06:04`, link `Sync health →`, actions include Rerun sync.
  Findings whose rules depend on Meta claims are not shown as resolved — they are collapsed
  into one grey line at the list bottom: `2 rules paused — no Meta data.` The word is **no
  data**, never `$0`.
- **Shopify sync down.** Same row shape: `Shopify sync broken — numbers current as of 08:00`.
  Because Shopify is the identity, the Ledger also sets a one-line dateline warning under the
  masthead: `Ledger frozen at 08:00.` All rules pause; the list shows only the sync row and
  `4 rules paused — no Shopify data.`
- **Mobile (<1024px).** No second sidebar; the constraint is a desktop constraint. The Ledger
  becomes a sticky one-line bar directly under the topbar: `Ledger · 2 findings` (or
  `Everything ties out`), tapping it opens a Sheet from the right with the identical list.
  The findings never inline into the page flow, on any width.

## 6. What I deliberately left out

- **Real-time anything.** No polling, no live counts, no "updated just now". Findings are a
  post-sync artifact and saying so is more honest than looking fresh.
- **Expand/detail-in-panel.** Two surfaces for one finding means two places to maintain and a
  reader who never knows if they've seen it all. One row, one link.
- **Badges and dots** on the left nav and the Attribution nav item. Unread counts are how
  inboxes become chores. The panel is already visible; that *is* the notification.
- **Severity colour beyond one red border.** Amber warning rows, tinted backgrounds, and icon
  taxonomies all inflate the same currency. Red is a monthly budget.
- **Bulk actions / select-all.** At 0–4 items, bulk is theatre.
- **Sorting, filtering, saved views.** Fixed order, five fixed rules.

## 7. Build notes (~1 week)

- **Shell:** shadcn `sidebar` primitives support a second `<Sidebar side="right"
  collapsible="icon">`; use it so collapse state persists in the same cookie as the left nav.
  Grid on the protected layout: `md:grid-cols-[auto_1fr_360px]`, panel `hidden lg:block`.
- **Rows:** plain `<article>` + hairline `divide-y divide-border/60`. Severity via
  `border-l-2 border-l-destructive`. Actions: `DropdownMenu` on a `Button size="icon"
  variant="ghost"`, revealed with `opacity-0 group-hover:opacity-100 focus-within:opacity-100`.
- **Type:** headline `text-sm font-medium`, mono line `font-mono text-xs tabular-nums
  text-muted-foreground`. Frozen numbers come from the finding record, not a live query.
- **Mobile:** reuse `Sheet` (`side="right"`) rendering the same list component; sticky bar is
  a `button` in the layout, `lg:hidden`.
- **History & Muted:** one `Dialog` with two tabs (`Tabs`), server-paginated list of resolved
  and muted findings with their frozen numbers and mute expiry. No new route.
- **Keyboard:** a single `useEffect` key handler scoped to the panel with a roving `tabIndex`;
  `⌥\` registered globally alongside the existing sidebar toggle.
- **Data:** findings are rows written by the sync job (rule id, severity, headline, frozen
  numbers JSON, evidence target, detected-at, streak days, muted-until, resolved-at). The
  panel reads one tRPC query, no subscription. Day 1–2 shell + row, day 3 states + all-clear,
  day 4 actions + optimistic undo, day 5 history dialog + mobile, buffer for dark-theme pass.
