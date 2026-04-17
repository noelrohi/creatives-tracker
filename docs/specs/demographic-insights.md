# Demographic Insights

## Context

Performance logs already store `age`, `gender`, `country`, and `device` breakdowns from CSV imports. The Meta API mapper extracts these fields, and the schema supports them. However, there are no queries or UI to surface this data — it's invisible to users.

This spec adds demographic breakdowns in two places: the dashboard overview and per-ad/creative detail pages.

**Note**: Meta's async report API restricts combining breakdowns with action metrics. Breakdown-level data currently comes via CSV import only. This is a known Meta limitation, not a bug.

---

## What Already Exists

- **Schema**: `performanceLogs` has `age`, `gender`, `country`, `device`, `platform`, `placement` columns
- **Mapper**: `meta-api-mapper.ts` extracts all breakdown fields
- **CSV import**: Breakdown-level rows are imported correctly
- **Export**: All breakdown fields included in CSV export

## What's Missing

- Aggregation queries (group by demographic dimension)
- Dashboard demographic section
- Per-ad/creative demographic breakdown UI

---

## Part 1: Dashboard Overview Demographics

**Goal**: Show top-level demographic breakdown on the main dashboard.

### New tRPC queries

**File**: `src/lib/trpc/routers/performance-log.ts`

Add `demographicBreakdown` query:

```
performanceLog.demographicBreakdown({
  accountId?, dateFrom, dateTo,
  dimension: "age" | "gender" | "country" | "device",
  metric: "spend" | "conversions" | "roas" | "impressions"
})
→ { label: string, value: number }[]
```

SQL: group by the chosen dimension column, aggregate the chosen metric, order by value desc, limit 10.

### Dashboard UI

**File**: `src/app/(dashboard)/page.tsx` or new component

Add a "Demographics" section below the existing KPI cards:

- Dimension selector: age / gender / country / device (tabs or dropdown)
- Horizontal bar chart or donut chart showing spend distribution
- Small table underneath with label, spend, conversions, ROAS per segment
- Default to `gender` breakdown on load

### Components

- **New**: `src/components/blocks/dashboard/demographic-chart.tsx` — bar/donut chart for one dimension
- Reuse existing chart primitives (recharts is already in the project)

---

## Part 2: Per-Ad / Per-Creative Demographics

**Goal**: Show demographic performance for a specific ad or creative on its detail page.

### New tRPC query

**File**: `src/lib/trpc/routers/performance-log.ts`

Add `adDemographicBreakdown` query:

```
performanceLog.adDemographicBreakdown({
  adId: string,    // or adIds: string[] for creative-level (all ads using that creative)
  dateFrom?, dateTo?,
  dimension: "age" | "gender" | "country" | "device"
})
→ { label: string, spend: number, conversions: number, roas: number, impressions: number }[]
```

For creative-level: join `ads.adCreativeId` to get all ads for a creative, then aggregate their perf logs.

### Creative Detail Page

**File**: `src/app/(protected)/creatives/[id]/page.tsx`

Add a new tab "Demographics" (or section within Performance tab):

- Same dimension selector as dashboard (age / gender / country / device)
- Bar chart showing spend by segment
- Table with spend, conversions, ROAS, CPA per segment
- Empty state: "No demographic data available — import breakdown-level data via CSV"

### Ads Tab Enhancement

**File**: `src/components/blocks/creatives/creative-ads-tab.tsx`

Optional: add a small expandable row or hover tooltip showing top country/device for each ad (lightweight, no full breakdown).

---

## Data Availability Note

Demographic data is only as complete as what's been imported. If a user has only synced via Meta API (no CSV), breakdown columns will be null. The UI should handle this gracefully:

- If no breakdown data exists for the selected dimension, show "No demographic data — import via CSV to see breakdowns"
- Don't show the Demographics tab/section if zero breakdown rows exist (query a count first)

---

## Verification

1. Import CSV with breakdown data (age/gender rows)
2. Dashboard: select "gender" → see bar chart with male/female/unknown spend distribution
3. Dashboard: switch to "country" → see top countries by spend
4. Creative detail: open a creative → Demographics tab → see breakdown for that creative's ads
5. Empty state: creative with no breakdown data → shows appropriate message
