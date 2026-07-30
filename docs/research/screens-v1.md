# Screens v1 — attribution screen spec

Resolution asset for [#97 Prototype: screens v1](https://github.com/noelrohi/creatives-tracker/issues/97).
Settled over 7 grilling rounds on the [living prototype](https://claude.ai/code/artifact/25c1c89e-a490-4f08-aa3f-a69b61f8cc40)
plus a delegate round (4 Opus designer specs + 3 judge memos, in `screens-v1/` beside this file).

## How the verdicts landed

| Round | Question | Verdict |
|---|---|---|
| 1–2 | Overall shape | Findings feed lives in a **persistent second sidebar**, not a page or dropdown (user call, overriding inbox-pattern options) |
| Delegate | Which sidebar chassis | **Queue** (ranked 1st by all 3 judges), grafted with the sync-stamped header sentence and "everything ties out" receipt |
| 4 | Voice | **Plain English** everywhere — no ROAS/attribution/UTM jargon (user rejected all media-buyer-voiced designs) |
| 5 | Row anatomy | **Tap** — rows closed until clicked (user overrode the "top item auto-open" recommendation) |
| 6 | Today's checks | Full list **pinned at the sidebar bottom**, always visible |
| 7 | Mobile | **Status bar + bottom sheet** |
| Final | Waterfall | **Keep the waterfall only** (from the reference prototype) — it replaces the plain bars, restyled with plain labels |
| Final | Date ranges | **Full set**: Today · Yesterday (default) · Last 7 days · Last 28 days · Custom |
| Final | First sync | **Progress bars** — "Loading your last 90 days…" with segments filling in as backfill lands |

## Where it lives

- **Route:** `src/app/(protected)/attribution/page.tsx` — a sibling of the dashboard and MER pages, inside the shared dashboard shell.
- **Sidebar entry:** "Attribution" in the **Analyze** group (Dashboard · MER · Attribution). Icon from `@/components/icons` (Solar set — `lucide-react` is blocked).
- **The findings rail is part of the attribution route's layout**, not the global shell, in v1. All v1 findings are attribution findings; promoting the rail app-wide is a later decision.
- Relationship to MER/dashboard: read-only siblings. The attribution page deep-links out (Shopify admin report, Meta vs Shopify view, order lists); nothing else changes.

## Desktop anatomy (≥ 1100px)

Three columns: app sidebar (existing, 200px) · main content (max ~700px) · findings rail (360px, sticky, independently scrollable).

### Top bar
Breadcrumb (`Org / Attribution`) + the **freshness caption** from the sync-health decision (#95):
"Shopify: 12 min ago · Meta: 3 hrs ago", right-aligned, escalating to warn/critical color when a source is stale
("Shopify: no connection since 8:00 · …").

### Shopify-outage banner
Screen-wide, above content (per #95): **"We lost the connection to Shopify at 8:00."** Numbers are correct up to
then — nothing is lost. Action: "Try again now".

### Main content — plain voice
1. **Kicker**: date range + store timezone (`Yesterday · Jul 28 · Asia/Bangkok`).
2. **Hero**: net sales total (per #93 revenue basis), subtitle "Total sales in Shopify · 92 orders".
   When frozen: append "· correct up to 8:00" in critical color.
3. **Date-range chips**: Today · Yesterday (default) · Last 7 days · Last 28 days · Custom (popover calendar).
   Multi-day ranges aggregate store-timezone days; the checker/findings always run on whole days.
4. **The waterfall** (survives from the reference prototype, restyled): total decomposes left→right into the
   seven buckets (#92). Segments are **navigation** — clicking one opens that bucket's order list. Labels wear
   the plain names: *Meta ads, Google ads, Klaviyo email, TikTok ads, Came on their own, Source unknown,
   No tracking info*. Colors: verified green for known sources, unattributed amber for Source unknown, neutral
   edge for No tracking info (token values below).
5. **Adds-up line**: "These add up to $6,820 — exactly your Shopify total ✓" + deep link **"Check in Shopify →"**
   to the admin *Sales over time* report with the same date range (the official reference per #93).
6. **Pending line**: "3 orders ($284) are too new to place — they'll be filed later today." (Pending state, #92 —
   excluded from the waterfall, never $0.)
7. **The Meta check**: "Meta says its ads made **$6,200** · we can confirm **$2,940** in Shopify." /
   "For every $1 spent on Meta you got **$1.63** back · your goal is $1.50." When Meta is stale both Meta-side
   figures show a "no data yet" chip (#95). Footer note (required by #93): "Meta's own reports count differently,
   so its numbers won't match Ads Manager exactly."
8. **Methodology footer**: survives as a collapsed **"How we count →"** disclosure at the page bottom — the
   plain-words glossary ("Source unknown = the order had tracking info but it didn't match any ad or email we
   know", "Confirmed = we found the real Shopify order behind Meta's claim", refund-day rule, timezone rule).

### Findings rail — "Needs your attention"
The Queue chassis in plain words. Top to bottom:

- **Header** (sticky): title + count pill (neutral pill; **red** when any critical finding). Below it the
  sync-stamped sentence: "Checked after the 6:12 update" / "All checks passed after the 6:12 update" /
  frozen variant "Numbers are correct up to 8:00" (warn color).
- **Rows** (Tap anatomy — all closed until clicked):
  - Closed: severity dot (critical red / warning amber) + plain-English headline + relative age. One line,
    wrapping allowed. Headlines are sentences a person would say: *"Meta says it made twice what we can
    confirm"*, *"7 orders arrived with broken link tags"*, *"We lost the connection to Shopify at 8:00"*.
  - Open (click toggles; selected row gets accent inset stripe + tinted background): a 2–4 sentence plain
    body citing the exact frozen numbers (#96), a deep link to the evidence surface ("See Meta vs Shopify →",
    "See the 7 orders →", "Connection details →"), and the action buttons.
  - **Actions** (the three from #96, re-worded to plain voice): **Snooze 7 days** (= mute), **Mark handled**
    (= resolve), **Try again now** (= rerun sync, sync findings only).
  - **Frozen behavior** (Shopify outage): non-sync rows dim to 60% opacity, actions disabled with caption
    "paused while numbers are frozen". The sync finding itself stays fully active.
- **All-clear receipt** (replaces rows when there are no findings): ✓ in a green circle, "**Nothing needs you
  today**", "All 5 daily checks passed. Everything adds up: $6,820."
- **Today's checks** (pinned above the footer, always visible): the five checker rules with plain names and a
  status word each — *Meta's claims vs real orders · Link tags on paid orders · Share of unknown sources ·
  Ad payback vs your goal · Data connections* → **OK** (green) / **Needs a look** (red or amber per severity) /
  **Waiting for data** (muted, when the input sync is stale).
- **Footer** (sticky): "Handled (4) · Snoozed (1)" — links to the resolved/muted lists.

### Copy rules (the plain-voice contract)
No screen string may use: ROAS, attribution, UTM, sync, verified, claims, unattributed, untracked, stale.
Translations, used everywhere including findings payload rendering:

| Internal term | On screen |
|---|---|
| ROAS | "back per $1" ("For every $1 spent you got $1.63 back") |
| claimed revenue | "Meta says it made…" |
| verified revenue | "we can confirm … in Shopify" |
| Unattributed bucket | "Source unknown" |
| Untracked bucket | "No tracking info" |
| Organic/direct bucket | "Came on their own" |
| UTM template | "link tags" |
| sync / sync failure | "connection" / "we lost the connection to…" |
| stale / frozen | "correct up to HH:MM" |
| null metric | "no data yet" (chip) — never $0 (#95) |

## Mobile (< 760px)

- Single column; rail hidden. A **status bar** sits sticky under the header: severity dot + "**Needs your
  attention** · 2 open" (or "— nothing") + chevron.
- Tapping it slides a **bottom sheet** over the page (max ~78% height, grab handle, scrim tap to dismiss)
  containing the identical rail content: header sentence, Tap rows, checks list.
- Waterfall degrades to a horizontally scrollable container (page body never scrolls sideways).

## States that ship

1. **Healthy** — data fresh, findings present or not.
2. **All clear** — no findings; rail shows the receipt; checks all OK.
3. **Meta down** — buckets keep updating; Meta-side figures show "no data yet" chips; verified-payback reads
   "can't tell right now"; rail carries the connection finding (#95).
4. **Shopify down** — banner + screen-wide freeze ("correct up to HH:MM"); rail frozen semantics above.
5. **First sync / empty** — before the 90-day backfill completes: "**Loading your last 90 days…**" with the
   waterfall segments filling in as Bulk Operation pages land (live progress from `shopify_sync_run`), and the
   rail showing "Getting set up — checks start after the first load." No findings fire during backfill.
6. **Date ranges** — every state above works for any chip; multi-day ranges sum store-tz days.

## Component approach

- **shadcn/ui + Tailwind v4 + app conventions** — none of the prototype's bespoke CSS ships. Pieces map to:
  `Button`, `Badge` (count pill), `Card`, `Sheet` (mobile inbox), `Popover` + `Calendar` (custom range),
  `Collapsible` ("How we count"), `Tooltip`. Icons via `@/components/icons`.
- App chrome uses the existing theme tokens (Figtree, cyan primary, warm neutrals) — the mock deliberately
  mirrored them, so nothing new there.
- **Chart/status palette** ships as CSS custom properties in `globals.css` (validated for contrast + CVD in
  both modes during the rounds):
  - verified/known green `#00805f` (dark `#149b7c`)
  - claim purple `#5a5fc7` (dark `#7b80e2`)
  - unknown amber `#9a5b1f` (dark `#bd8440`)
  - severity: critical `#b4291e`/`#e07b6d`, warning `#b07d1a`/`#d9a05b`, good `#1f7a5c`/`#3cc5a3` with matching
    soft backgrounds.
- **Data:** main content is a server component reading the live GROUP BY endpoint (#94); the rail is a client
  component on a tRPC findings router (rows from the daily check job, #96); freshness caption reads
  `shopify_sync_run` / Meta sync state (#95).

## Not in screens v1

- Findings history page (footer links can land on a simple filtered list; no dedicated design).
- Per-campaign drill-downs — deep links only.
- Configurable thresholds/alerts (rejected in #96), app-wide findings rail, waterfall animations.
