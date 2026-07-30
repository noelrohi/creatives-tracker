/**
 * Every word this screen says, in one file, so the plain-English voice can be
 * audited in one place.
 *
 * The contract: no rendered string uses the internal vocabulary (the report
 * beside this branch lists it). Sentences say what a shop owner would say —
 * "Meta says it made…", "we can confirm … in Shopify", "back per $1",
 * "correct up to 8:00", "no data yet" instead of a fake $0.
 *
 * The only words below that come from the API rather than from a person are the
 * object *keys*: bucket names and finding-rule names are wire identifiers, and
 * identifiers are outside the voice contract. Nothing keyed by them is printed
 * except the value.
 */

import type { AttributionBucket } from "@/lib/attribution-bucket";
import type { CheckStatus, FindingType } from "@/lib/findings";
import {
  formatCentsMoney,
  formatClock,
  formatCount,
  formatDay,
  formatMoneyExact,
  formatPercent,
} from "./format";

export type VoiceContext = { currency: string; timeZone: string };

export type FindingItem = {
  id: string | null;
  type: FindingType;
  firedAt: Date | string | null;
  periodStart: string | null;
  periodEnd: string | null;
  payload: Record<string, unknown> | null;
  resolvedAt: Date | string | null;
  mutedUntil: Date | string | null;
};

export type Severity = "critical" | "warning";

/* ------------------------------------------------------------------ */
/* Page chrome                                                         */
/* ------------------------------------------------------------------ */

export const page = {
  /**
   * The nav label and breadcrumb keep the product name the sidebar decision
   * fixed verbatim; everything below the top bar is plain voice.
   */
  navLabel: "Attribution",
  title: "Where your sales came from",
  heroSubtitle: (orderCount: number) =>
    `Total sales in Shopify · ${formatCount(orderCount)} ${
      orderCount === 1 ? "order" : "orders"
    }`,
  correctUpTo: (clock: string) => `· correct up to ${clock}`,
  kicker: (rangeLabel: string, dayLabel: string, timeZone: string) =>
    `${rangeLabel} · ${dayLabel} · ${timeZone}`,
  noDataYet: "no data yet",
  nothingHere: "nothing here",
  storeMissing: "Connect your Shopify store to see where your sales came from.",
};

export const freshness = {
  fresh: (source: string, age: string) => `${source}: ${age}`,
  lost: (source: string, clock: string) =>
    `${source}: no connection since ${clock}`,
  never: (source: string) => `${source}: no connection yet`,
  shopify: "Shopify",
  meta: "Meta",
};

export const banner = {
  title: (clock: string) => `We lost the connection to Shopify at ${clock}.`,
  titleNoClock: "We lost the connection to Shopify.",
  body: "Numbers are correct up to then — nothing is lost.",
  action: "Try again now",
};

/* ------------------------------------------------------------------ */
/* Date range chips                                                    */
/* ------------------------------------------------------------------ */

export const RANGE_PRESETS = [
  "today",
  "yesterday",
  "last7",
  "last28",
  "custom",
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number];

export const rangeLabels: Record<RangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7: "Last 7 days",
  last28: "Last 28 days",
  custom: "Custom",
};

/* ------------------------------------------------------------------ */
/* Buckets                                                            */
/* ------------------------------------------------------------------ */

export const bucketLabels: Record<AttributionBucket, string> = {
  meta: "Meta ads",
  google: "Google ads",
  klaviyo: "Klaviyo email",
  tiktok: "TikTok ads",
  organic_direct: "Came on their own",
  unattributed: "Source unknown",
  untracked: "No tracking info",
};

export const waterfall = {
  totalLabel: "Total sales",
  caption: "Tap a piece to see the orders behind it",
  addsUp: (sum: string, total: string, matches: boolean) =>
    matches
      ? `These add up to ${sum} — exactly your Shopify total ✓`
      : `These add up to ${sum}, and your Shopify total is ${total}. We're looking into the difference.`,
  checkInShopify: "Check in Shopify →",
  pending: (orderCount: number, money: string) =>
    `${formatCount(orderCount)} ${
      orderCount === 1 ? "order" : "orders"
    } (${money}) ${orderCount === 1 ? "is" : "are"} too new to place — they'll be filed later today.`,
};

const CHANNEL_BUCKETS: readonly AttributionBucket[] = [
  "meta",
  "google",
  "klaviyo",
  "tiktok",
];

export const orders = {
  titleFor: (bucket: AttributionBucket) => {
    if (CHANNEL_BUCKETS.includes(bucket)) {
      return `Orders from ${bucketLabels[bucket]}`;
    }
    if (bucket === "organic_direct") return "Orders that came on their own";
    return `Orders filed under ${bucketLabels[bucket]}`;
  },
  close: "Close",
  empty: "No orders in this piece for these days.",
  more: "Show more orders",
  loading: "Getting the orders…",
  columns: {
    order: "Order",
    when: "When",
    sales: "Sales",
    cameFrom: "Where it came from",
    tags: "Link tags",
  },
  matchedMeta: "matched to a Meta ad",
  tooNew: "too new to place",
  noTags: "—",
};

/* ------------------------------------------------------------------ */
/* The Meta check                                                      */
/* ------------------------------------------------------------------ */

export const metaCheck = {
  title: "The Meta check",
  claimSentence: (metaSays: string, weConfirm: string) =>
    `Meta says its ads made ${metaSays} · we can confirm ${weConfirm} in Shopify.`,
  claimSentenceNoData: (weConfirm: string) =>
    `We can confirm ${weConfirm} in Shopify.`,
  paybackSentence: (back: string, goal: string) =>
    `For every $1 spent on Meta you got ${back} back · your goal is ${goal}.`,
  paybackUnknown: "How much you got back per $1 — can't tell right now.",
  spendLabel: "Spent on Meta",
  metaSaysLabel: "Meta says its ads made",
  weConfirmLabel: "We can confirm in Shopify",
  backPerDollar: "Back per $1",
  goal: (goal: string) => `goal ${goal}`,
  seeDetail: "See Meta vs Shopify →",
  pendingNote: (orderCount: number) =>
    `${formatCount(orderCount)} ${
      orderCount === 1 ? "order is" : "orders are"
    } still too new to place, so this can still move.`,
  footnote:
    "Meta's own reports count differently, so its numbers won't match Ads Manager exactly.",
};

/* ------------------------------------------------------------------ */
/* How we count                                                        */
/* ------------------------------------------------------------------ */

export const howWeCount = {
  trigger: "How we count",
  entries: (timeZone: string) => [
    {
      term: bucketLabels.unattributed,
      body:
        "The order had tracking info, but it didn't match any ad or email we know.",
    },
    {
      term: bucketLabels.untracked,
      body:
        "The order arrived with nothing we could read — no link tags at all.",
    },
    {
      term: bucketLabels.organic_direct,
      body:
        "Nothing paid in the shopper's last visit. They came to you by themselves.",
    },
    {
      term: "Confirmed",
      body:
        "We found the real Shopify order behind what Meta says its ads made, by matching the ad on the order.",
    },
    {
      term: "Refunds",
      body:
        "A refund counts on the day the money went back, not on the day of the original order.",
    },
    {
      term: "Days",
      body: `A day starts and ends in your store's own time (${timeZone}), so it matches what you see in Shopify.`,
    },
    {
      term: "Too new to place",
      body:
        "Shopify hasn't finished telling us how a very new order arrived. Those orders are counted in your total but kept out of the pieces until we know.",
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Findings rail                                                       */
/* ------------------------------------------------------------------ */

export const rail = {
  title: "Needs your attention",
  checked: (clock: string) => `Checked after the ${clock} update`,
  checkedAllClear: (clock: string) =>
    `All checks passed after the ${clock} update`,
  checkedNoStamp: "Checked after the last update",
  checkedNoStampAllClear: "All checks passed",
  frozen: (clock: string) => `Numbers are correct up to ${clock}`,
  frozenNoClock: "Numbers are correct up to the last update",
  allClearTitle: "Nothing needs you today",
  allClearBody: (checkCount: number, total: string) =>
    `All ${checkCount} daily checks passed. Everything adds up: ${total}.`,
  allClearBodyNoTotal: (checkCount: number) =>
    `All ${checkCount} daily checks passed.`,
  firstLoadTitle: "Getting set up",
  firstLoadBody: "Checks start after the first load.",
  footer: (handled: number, snoozed: number) =>
    `Handled (${formatCount(handled)}) · Snoozed (${formatCount(snoozed)})`,
  footerHandled: (handled: number) => `Handled (${formatCount(handled)})`,
  footerSnoozed: (snoozed: number) => `Snoozed (${formatCount(snoozed)})`,
  mobileOpen: (openCount: number) =>
    `Needs your attention · ${formatCount(openCount)} open`,
  mobileNone: "Needs your attention — nothing",
  mobileClose: "Close",
};

export const actions = {
  snooze: "Snooze 7 days",
  resolve: "Mark handled",
  rerun: "Try again now",
  frozenCaption: "paused while numbers are frozen",
  readOnlyCaption: "ask an admin to act on this",
  snoozed: (clock: string) => `Snoozed until ${clock}`,
};

export const checks = {
  title: "Today's checks",
  names: {
    meta_overclaim: "What Meta says vs real orders",
    broken_utm_template: "Link tags on paid orders",
    unattributed_spike: "Share of unknown sources",
    roas_below_target: "Ad payback vs your goal",
    sync_failure: "Data connections",
  } satisfies Record<FindingType, string>,
  status: {
    ok: "OK",
    needs_look: "Needs a look",
    waiting_for_data: "Waiting for data",
  } satisfies Record<CheckStatus, string>,
};

export const firstLoad = {
  title: "Loading your last 90 days…",
  body: "Your orders are arriving now. The pieces below fill in as they land.",
  progress: (daysLoaded: number, daysTotal: number) =>
    `${formatCount(daysLoaded)} of ${formatCount(daysTotal)} days in`,
  waiting: "Waiting for the first orders to arrive…",
};

/* ------------------------------------------------------------------ */
/* Finding rows — headline, body, evidence                             */
/* ------------------------------------------------------------------ */

export const severityByType: Record<FindingType, Severity> = {
  sync_failure: "critical",
  meta_overclaim: "critical",
  unattributed_spike: "warning",
  broken_utm_template: "warning",
  roas_below_target: "warning",
};

/** Payloads are frozen at fire time and read defensively — never re-derived. */
function num(payload: Record<string, unknown> | null, key: string): number | null {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rows(
  payload: Record<string, unknown> | null,
  key: string,
): Array<Record<string, unknown>> {
  const value = payload?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null,
  );
}

function cell(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sourceName(connector: string | null): string {
  return connector === "meta" ? freshness.meta : freshness.shopify;
}

function sumCells(
  entries: Array<Record<string, unknown>>,
  key: string,
): number | null {
  const values = entries
    .map((entry) => cell(entry, key))
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0);
}

export function findingHeadline(item: FindingItem, ctx: VoiceContext): string {
  const payload = item.payload;

  switch (item.type) {
    case "meta_overclaim": {
      const multiple = num(payload, "multiple");
      if (multiple === 2) return "Meta says it made twice what we can confirm";
      return multiple === null
        ? "Meta says it made far more than we can confirm"
        : `Meta says it made over ${multiple}× what we can confirm`;
    }

    case "unattributed_spike": {
      const days = rows(payload, "days");
      const share = formatPercent(cell(days[days.length - 1] ?? {}, "share"));
      return share
        ? `${share} of sales came in with a source we can't read`
        : "More sales than usual came in with a source we can't read";
    }

    case "broken_utm_template": {
      const orderCount = num(payload, "orderCount");
      return orderCount === null
        ? "Orders arrived with broken link tags"
        : `${formatCount(orderCount)} ${
            orderCount === 1 ? "order" : "orders"
          } arrived with broken link tags`;
    }

    case "sync_failure": {
      const source = sourceName(str(payload, "connector"));
      const clock = formatClock(str(payload, "lastSuccessAt"), ctx.timeZone);
      return clock
        ? `We lost the connection to ${source} at ${clock}`
        : `We can't reach ${source} right now`;
    }

    case "roas_below_target": {
      const days = num(payload, "consecutiveDays");
      return days === null
        ? "Your Meta ads paid back less than your goal all week"
        : `Your Meta ads paid back less than your goal ${formatCount(days)} days running`;
    }
  }
}

export function findingBody(item: FindingItem, ctx: VoiceContext): string[] {
  const payload = item.payload;
  const money = (cents: number | null) =>
    formatCentsMoney(cents, ctx.currency) ?? page.noDataYet;

  switch (item.type) {
    case "meta_overclaim": {
      const days = rows(payload, "days");
      const claimed = sumCells(days, "claimedCents");
      const confirmed = sumCells(days, "verifiedCents");
      const gap =
        claimed !== null && confirmed !== null ? claimed - confirmed : null;
      const dayCount = days.length;

      return [
        `Over the last ${formatCount(dayCount)} days Meta said its ads made ${money(
          claimed,
        )}. We could only find ${money(confirmed)} of that in real Shopify orders.`,
        gap === null
          ? "The two numbers are far apart."
          : `That leaves ${money(gap)} we can't put behind a Shopify order.`,
        "Meta counts a sale when someone saw or clicked an ad, so part of that belongs to other channels — but a gap this wide usually means the ads are being given credit twice.",
      ];
    }

    case "unattributed_spike": {
      const days = rows(payload, "days");
      const worst = days[days.length - 1] ?? {};
      const share = formatPercent(cell(worst, "share")) ?? page.noDataYet;
      const usual =
        formatPercent(num(payload, "baselineMedianShare")) ?? page.noDataYet;
      const day = typeof worst.day === "string" ? formatDay(worst.day) : null;

      return [
        `${
          day ? `On ${day}, ` : ""
        }${money(cell(worst, "unattributedCents"))} of ${money(
          cell(worst, "totalCents"),
        )} came in carrying link tags we couldn't match to anything we know — that's ${share} of the day.`,
        `Normally that sits around ${usual}.`,
        `It has held for ${formatCount(days.length)} days in a row, so it is worth a look: usually a link somewhere is tagged wrong.`,
      ];
    }

    case "broken_utm_template": {
      const orderCount = num(payload, "orderCount");
      const day = str(payload, "day");
      const samples = rows(payload, "samples");
      const example = samples[0];
      const exampleTag =
        example && typeof example.utmSource === "string"
          ? `${example.utmSource}${
              typeof example.utmMedium === "string" ? ` / ${example.utmMedium}` : ""
            }`
          : null;

      return [
        `${orderCount === null ? "Several" : formatCount(orderCount)} orders${
          day ? ` on ${formatDay(day)}` : ""
        } came from links that say the visit was paid, but the tags on them don't match any ad we know.`,
        exampleTag
          ? `One of them arrived tagged "${exampleTag}".`
          : "The tags we received don't name an ad we can find.",
        "That is usually a link builder on a new ad set writing the wrong tag. Fixing the link puts these orders back with their channel.",
      ];
    }

    case "sync_failure": {
      const source = sourceName(str(payload, "connector"));
      const clock = formatClock(str(payload, "lastSuccessAt"), ctx.timeZone);

      return [
        clock
          ? `${source} stopped answering us at ${clock}.`
          : `${source} isn't answering us right now.`,
        clock
          ? `Everything up to ${clock} is correct and nothing is lost.`
          : "Everything we already have is correct and nothing is lost.",
        "New orders will fill themselves in as soon as the connection is back. You can try again now.",
      ];
    }

    case "roas_below_target": {
      const days = rows(payload, "days");
      const target = num(payload, "target");
      const revenue = sumCells(days, "verifiedRevenueCents");
      const spend = sumCells(days, "spendCents");
      const back =
        revenue !== null && spend !== null && spend > 0
          ? formatMoneyExact(revenue / spend, ctx.currency)
          : null;
      const goal =
        target === null ? null : formatMoneyExact(target, ctx.currency);

      return [
        `Over the last ${formatCount(days.length)} days you spent ${money(
          spend,
        )} on Meta and we can confirm ${money(revenue)} of sales behind it.`,
        back && goal
          ? `That is ${back} back for every $1 spent, against your goal of ${goal}.`
          : "That is less back per $1 than your goal.",
        "It has been under your goal every day this week, so it isn't a one-day dip.",
      ];
    }
  }
}

export type Evidence =
  | { kind: "link"; label: string; href: string }
  | { kind: "orders"; label: string; bucket: AttributionBucket };

export function findingEvidence(
  item: FindingItem,
  links: { metaVsShopify: string; connections: string },
): Evidence {
  switch (item.type) {
    case "meta_overclaim":
    case "roas_below_target":
      return {
        kind: "link",
        label: metaCheck.seeDetail,
        href: links.metaVsShopify,
      };

    case "unattributed_spike":
      return {
        kind: "orders",
        label: "See those orders →",
        bucket: "unattributed",
      };

    case "broken_utm_template": {
      const orderCount = num(item.payload, "orderCount");
      return {
        kind: "orders",
        label:
          orderCount === null
            ? "See those orders →"
            : `See the ${formatCount(orderCount)} orders →`,
        bucket: "unattributed",
      };
    }

    case "sync_failure":
      return {
        kind: "link",
        label: "Connection details →",
        href: links.connections,
      };
  }
}

/** Only a connection finding can be re-run; the other two act on any row. */
export function canRerun(item: FindingItem): boolean {
  return item.type === "sync_failure";
}
