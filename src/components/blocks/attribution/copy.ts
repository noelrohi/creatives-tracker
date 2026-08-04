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

import {
  funnelStageName,
  funnelStageWords,
  funnelStageWordsFor,
  isFunnelStage,
} from "@/components/blocks/funnel-stage-copy";
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
import { bucketOrdersUrl } from "./shopify-links";

export type VoiceContext = { currency: string; timeZone: string };

export type FindingItem = {
  id: string | null;
  type: FindingType;
  firedAt: Date | string | null;
  periodStart: string | null;
  periodEnd: string | null;
  payload: Record<string, unknown> | null;
  resolvedAt: Date | string | null;
  /** How it closed. Null on rows closed before the two were told apart. */
  resolution: "handled" | "retired" | null;
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
  /**
   * Comparison lines. They sit on their own line under the figure they belong
   * to, so they carry no leading separator — the caller joins them.
   */
  previousTotal: (money: string, days: number) =>
    days === 1
      ? `${money} the day before`
      : `${money} the ${formatCount(days)} days before`,
  previousBack: (money: string, days: number) =>
    days === 1
      ? `was ${money} the day before`
      : `was ${money} the ${formatCount(days)} days before`,
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
  ai: "AI assistants",
  organic_direct: "Came on their own",
  unattributed: "Source unknown",
  untracked: "No tracking info",
};

/**
 * The channel list and the tie-out under it. The tie-out is the product's
 * differentiator, so it is not a caption: `ledgerLines` in `./ledger` names the
 * lines of a totals block drawn in the same columns as the channels.
 */
export const ledger = {
  totalLabel: "Net sales",
  caption: "Tap a row to see the orders behind it",
  /** The totals block: what each ruled line is called. */
  piecesLabel: "The pieces",
  /**
   * Our own Net sales for the range — deliberately not called "Shopify Net
   * sales". We do not read Shopify's reported figure, so nothing on this screen
   * may claim the two agree; the sentence below says what was actually checked
   * (every order landed somewhere) and sends the reader to Shopify to compare.
   */
  ourNetSalesLabel: "Net sales",
  tooNewLabel: "Too new to place",
  gapLabel: "Gap we're looking into",
  shareLabel: "100%",
  addsUp: (
    sum: string,
    total: string,
    matches: boolean,
    pendingMoney: string | null,
    difference: string | null,
  ) => {
    if (matches && pendingMoney) {
      return `Every order landed in one piece: these hold ${sum}, another ${pendingMoney} is still being filed, and together that's our ${total}.`;
    }
    if (matches) {
      return `Every order landed in exactly one piece — they add up to our ${sum}.`;
    }
    return difference
      ? `These add up to ${sum}, but our Net sales for the same days are ${total} — a gap of ${difference} we're looking into.`
      : `These add up to ${sum}, and our Net sales for the same days are ${total}. We're looking into the difference.`;
  },
  checkInShopify: "Check the Net sales row in Shopify (all channels) →",
  pending: (orderCount: number, money: string) =>
    `${formatCount(orderCount)} ${
      orderCount === 1 ? "order" : "orders"
    } (${money}) ${orderCount === 1 ? "is" : "are"} too new to place — they'll be filed later today.`,
  hiddenChannels: (count: number) =>
    `${formatCount(count)} ${
      count === 1 ? "channel" : "channels"
    } with no sales hidden`,
  emptyChannelsShown: (count: number) =>
    `${formatCount(count)} ${
      count === 1 ? "channel has" : "channels have"
    } no sales.`,
  showHidden: "Show them",
  hideEmpty: "Hide them",
};

/**
 * The four figures in the panel header, read left to right as the story:
 * what came in, what went out on Meta, what we could match, what came back.
 * "Meta says" is deliberately absent — it appears once, inside the Meta check.
 */
export const headerRail = {
  netSales: "Net sales",
  spend: "spent on Meta",
  confirm: "we confirm in Shopify",
  back: "back per $1 on Meta",
  orders: (orderCount: number) =>
    `${formatCount(orderCount)} ${orderCount === 1 ? "order" : "orders"}`,
};

const CHANNEL_BUCKETS: readonly AttributionBucket[] = [
  "meta",
  "google",
  "klaviyo",
  "tiktok",
  "ai",
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
  download: "Download CSV",
  csvColumns: [
    "Order",
    "Day",
    "Time",
    "Net sales",
    "Where it came from",
    "Link tags",
  ],
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
    'Meta counts a sale when someone buys within 7 days of clicking or 1 day of seeing one of its ads, so "Meta says" always reads higher than what we can match to a real order. A steady gap is normal — the daily checks watch for it widening.',
};

/* ------------------------------------------------------------------ */
/* Campaigns                                                           */
/* ------------------------------------------------------------------ */

/**
 * The cut list. "Meta says" appears here as a column head because the row it
 * labels is Meta's own number for that campaign — the footnote under the table
 * says why it always reads higher than what we confirm.
 */
export const campaigns = {
  title: "Campaign by campaign",
  /**
   * The worst payback first, because that is the row worth acting on. Named so
   * the fold does not have to be opened to know which campaign to look at.
   */
  summary: (worstName: string, back: string, campaignCount: number) =>
    `${worstName} gives back ${back} per $1 · ${formatCount(campaignCount)} ${
      campaignCount === 1 ? "campaign" : "campaigns"
    }`,
  /** Spend with nothing behind it is the sharpest version of the same list. */
  summaryNoBack: (worstName: string, spent: string, campaignCount: number) =>
    `${worstName} spent ${spent} with no orders behind it · ${formatCount(
      campaignCount,
    )} ${campaignCount === 1 ? "campaign" : "campaigns"}`,
  columns: {
    campaign: "Campaign",
    spent: "Spent",
    metaSays: "Meta says",
    weConfirm: "We confirm",
    back: "Back per $1",
  },
  orders: (orderCount: number) =>
    `${formatCount(orderCount)} ${orderCount === 1 ? "order" : "orders"}`,
  noOrders: "no orders",
  empty: "No Meta campaigns ran on these days.",
  unresolvedLabel: "Couldn't tell which campaign",
  /**
   * The row can hold money without holding a single order: a refund of an order
   * from before the range, or spend on an ad whose ad set has been deleted. The
   * note has to stop short of claiming orders it does not have.
   */
  unresolvedNoteNoOrders:
    "This is Meta money we can't put behind a campaign: a refund of an older order, or spend on an ad whose ad set was deleted. It is still counted in your Meta total.",
  unresolvedNote: (orderCount: number) =>
    `${formatCount(orderCount)} Meta ${
      orderCount === 1 ? "order" : "orders"
    } came in with link tags that don't name a campaign, so we can't put ${
      orderCount === 1 ? "it" : "them"
    } behind one. ${orderCount === 1 ? "It is" : "They are"} still counted in your Meta total.`,
  footnote:
    '"We confirm" is the real Shopify orders behind each campaign, so it always reads lower than "Meta says" — the two count different things, and a steady gap is normal. Every row plus the last one adds up to your Meta ads total above.',
};

/* ------------------------------------------------------------------ */
/* How we count                                                        */
/* ------------------------------------------------------------------ */

/**
 * One sentence per idea, written once. The glossary prints them in full; the
 * `?` marks on the screen hand the same sentence to a tooltip, so a long
 * explanation is always reachable without being printed beside every figure.
 */
const glossary = {
  netSales:
    'Sales after discounts and refunds, before shipping and tax — the same as the Net sales row in Shopify\'s Finances summary. Two things move that row: Shopify\'s own "Total sales" line adds shipping and tax on top, so it reads higher, and the report remembers the last sales channel you looked at. We count every channel, so set it to "All channels" to compare.',
  unattributed:
    "The order had tracking info, but it didn't match any ad or email we know.",
  untracked:
    "The order arrived with nothing we could read — no link tags at all.",
  organicDirect:
    "Nothing paid in the shopper's last visit. They came to you by themselves.",
  meta: "An order files under Meta ads when the shopper's last visit before checkout came from a Meta ad. We then look for that exact ad on the order to call it confirmed.",
  ai: "The shopper's last visit came from an AI assistant — ChatGPT and the like — sending them to your store.",
  confirmed:
    "We found the real Shopify order behind what Meta says its ads made, by matching the ad on the order.",
  refunds:
    "A refund counts on the day the money went back, not on the day of the original order.",
  days: (timeZone: string) =>
    `A day starts and ends in your store's own time (${timeZone}), so it matches what you see in Shopify.`,
  tooNew:
    "Shopify hasn't finished telling us how a very new order arrived. Those orders are counted in your total but kept out of the pieces until we know.",
};

/** What each `?` on the screen says when you reach for it. */
export const help = {
  netSales: glossary.netSales,
  unattributed: glossary.unattributed,
  untracked: glossary.untracked,
  tooNew: glossary.tooNew,
  metaSays: metaCheck.footnote,
  back: (back: string, goal: string | null) =>
    goal
      ? `For every $1 spent on Meta you got ${back} back · your goal is ${goal}.`
      : `For every $1 spent on Meta you got ${back} back.`,
  backUnknown: metaCheck.paybackUnknown,
  confirm: glossary.confirmed,
};

/** Per-bucket help, so a row can explain itself without a caption. */
export const bucketHelp: Partial<Record<AttributionBucket, string>> = {
  meta: glossary.meta,
  ai: glossary.ai,
  organic_direct: glossary.organicDirect,
  unattributed: glossary.unattributed,
  untracked: glossary.untracked,
};

export const howWeCount = {
  trigger: "How we count",
  summary: "Net sales, days, refunds, too new to place",
  entries: (timeZone: string) => [
    { term: "Net sales", body: glossary.netSales },
    { term: bucketLabels.unattributed, body: glossary.unattributed },
    { term: bucketLabels.untracked, body: glossary.untracked },
    { term: bucketLabels.organic_direct, body: glossary.organicDirect },
    { term: bucketLabels.meta, body: glossary.meta },
    { term: bucketLabels.ai, body: glossary.ai },
    { term: "Confirmed", body: glossary.confirmed },
    { term: "Refunds", body: glossary.refunds },
    { term: "Days", body: glossary.days(timeZone) },
    { term: "Too new to place", body: glossary.tooNew },
  ],
};

/**
 * The three folds under the ledger. Each summary carries its own answer, so on
 * a quiet morning none of them has to be opened.
 */
export const folds = {
  attention: "Needs your attention",
  attentionOpen: (openCount: number, headline: string) =>
    `${formatCount(openCount)} open · ${headline}`,
  attentionAllClear: (checkCount: number) =>
    `all clear · all ${formatCount(checkCount)} daily checks passed`,
  // The banner above already carries the clock; repeating it here says the same
  // thing a third time on the same screen.
  attentionFrozen: "paused while numbers are frozen",
  attentionFirstLoad: "checks start after the first load",
  meta: metaCheck.title,
  metaSummary: (
    metaSays: string | null,
    confirm: string,
    back: string | null,
  ) =>
    [
      metaSays ? `Meta says ${metaSays}` : null,
      `we confirm ${confirm}`,
      back ? `${back} back per $1` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
  metaSummaryNoData: "no data yet",
  how: "How we count",
  howSummary: "Net sales, days, refunds, too new to place",
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
  resolvedHandled: "Marked handled by your team",
  // Nobody closed this one; the rule that raised it stopped holding.
  resolvedRetired: "Closed itself once the rule no longer held",
};

export const checks = {
  title: "Today's checks",
  names: {
    meta_overclaim: "What Meta says vs real orders",
    broken_utm_template: "Link tags on paid orders",
    unattributed_spike: "Share of unknown sources",
    roas_below_target: "Ad payback vs your goal",
    sync_failure: "Data connections",
    ad_lp_funnel_mismatch: "Ad and landing-page fit",
    untagged_spend: "Creative tagging coverage",
    utm_template_drift: "New-ad link tags",
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
  ad_lp_funnel_mismatch: "warning",
  untagged_spend: "warning",
  utm_template_drift: "warning",
};

/** Payloads are frozen at fire time and read defensively — never re-derived. */
function num(
  payload: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(
  payload: Record<string, unknown> | null,
  key: string,
): string | null {
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

/**
 * Who the drifting link tags belong to. The rule fires on two different kinds
 * of offender and the sentence has to be true for whichever it caught: an ad we
 * could match by name is genuinely new, but an unmatched one may be deleted or
 * never synced — we cannot know when it was made, so we don't claim it is new.
 */
function driftOffenderPhrase(payload: Record<string, unknown> | null): string {
  const methods = new Set(
    rows(payload, "offenders")
      .map((offender) => offender.matchMethod)
      .filter((method): method is string => typeof method === "string"),
  );
  const named = methods.has("name");
  const unnamed = methods.has("unmatched");

  if (named && unnamed) {
    return "a new ad and an ad we can't identify, both using non-standard link tags";
  }
  if (named) return "a new ad using non-standard link tags";
  if (unnamed) return "an ad we can't identify, using non-standard link tags";
  // Fired before the offenders carried a match method: say only what holds.
  return "an ad using non-standard link tags";
}

export function findingHeadline(item: FindingItem, ctx: VoiceContext): string {
  const payload = item.payload;

  switch (item.type) {
    case "meta_overclaim": {
      const windowMultiple = num(payload, "windowMultiple");
      const baselineMultiple = num(payload, "baselineMultiple");
      if (windowMultiple !== null && baselineMultiple !== null) {
        return `Meta is running ${windowMultiple}× ahead — its usual is ${baselineMultiple}×`;
      }
      // No baseline yet: the measured multiple is still known, and saying it
      // beats falling back to the rule's threshold as though it were measured.
      if (windowMultiple !== null) {
        return `Meta is running ${windowMultiple}× ahead of the orders we can match`;
      }
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

    case "ad_lp_funnel_mismatch":
      return (
        str(payload, "headline") ??
        "An ad is sending colder traffic to a hotter landing page"
      );

    case "untagged_spend":
      return (
        str(payload, "headline") ?? "Active ad spend is missing creative tags"
      );

    case "utm_template_drift":
      return (
        str(payload, "headline") ?? "A new ad is sending non-standard UTMs"
      );
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
        // Only the first sentence is always true. Whether the gap is unusual
        // is a claim we can only make once there is a baseline to compare it
        // against — without one, the rule fired on size alone and says so.
        num(payload, "baselineMultiple") === null
          ? "Meta counts a sale when someone buys within 7 days of clicking or 1 day of seeing one of its ads — across devices — so its number always runs ahead of the orders we can match. We don't have enough weeks behind you yet to know what a normal gap looks like for your store, so this one is flagged on size alone."
          : "Meta counts a sale when someone buys within 7 days of clicking or 1 day of seeing one of its ads — across devices — so its number always runs ahead of the orders we can match. A steady gap is normal. This fired because the gap is wider than yours usually is.",
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
              typeof example.utmMedium === "string"
                ? ` / ${example.utmMedium}`
                : ""
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

    case "ad_lp_funnel_mismatch": {
      const count = num(payload, "totalCount");
      return [
        `${count === null ? "At least one ad" : `${formatCount(count)} ${count === 1 ? "ad" : "ads"}`} sent colder traffic to a landing page written for people closer to buying.`,
        "Warmer ads pointing to colder pages are legitimate retargeting and are not included.",
      ];
    }

    case "untagged_spend": {
      const share = formatPercent(num(payload, "share")) ?? page.noDataYet;
      const count = num(payload, "untaggedAdCount");
      return [
        `${count === null ? "Some active ads" : `${formatCount(count)} active ads`} are missing funnel stage, persona, angle, or awareness tags and carry ${share} of active Meta spend.`,
        "Slice-level alerts stay paused until at least 80% of active spend is fully tagged.",
      ];
    }

    case "utm_template_drift": {
      const orderCount = num(payload, "orderCount");
      return [
        `${orderCount === null ? "Several orders" : `${formatCount(orderCount)} ${orderCount === 1 ? "order" : "orders"}`} yesterday came through ${driftOffenderPhrase(payload)}.`,
        "New ads should send their numeric ad ID in utm_content so orders resolve without a name fallback.",
      ];
    }
  }
}

/* ------------------------------------------------------------------ */
/* Drawers — the three creative-insights findings                      */
/* ------------------------------------------------------------------ */

export const drawers = {
  stageName: (stage: string | null) => funnelStageName(stage),
  stageWords: (stage: string | null) => funnelStageWordsFor(stage),

  mismatch: {
    adTitle: "The ad",
    pageTitle: "The page it links",
    adTags: (stage: string) => `Tagged ${stage}`,
    /** An ai-stamped funnel stage says so; a human-set one is simply the truth. */
    adGuessPill: "our guess",
    adSpend: (spend: string) => `${spend} spent in the last 7 days`,
    /** What the week's spend brought back, and how far it got people. */
    adBack: (money: string) => `${money} came back`,
    adLand: (views: number) =>
      `${formatCount(views)} ${views === 1 ? "person" : "people"} reached the page`,
    seeAd: "See the ad →",
    guessPill: "our guess",
    unconfirmedPill: "AI-classified, unconfirmed",
    confirmedPill: "confirmed by your team",
    pageReads: (stage: string) => `Reads as ${stage}`,
    pageFor: (stage: string | null) =>
      `Written for ${
        isFunnelStage(stage) ? funnelStageWords[stage] : "an audience we can't place"
      }.`,
    question: (path: string, stage: string | null) =>
      `Is ${path} written for ${
        isFunnelStage(stage) ? funnelStageWords[stage] : "the audience we guessed"
      }?`,
    yes: "Yes — keep the alert",
    no: "No — it's colder",
    visit: "Show me the page",
    pick: "Which is it written for?",
    cancel: "Cancel",
    sticks:
      "Your answer sticks: the page's stage stops being a guess, here and in every future alert.",
    saved: (stage: string) =>
      `Saved — the page is now confirmed as ${stage.toLowerCase()}.`,
    others: (count: number) =>
      `${formatCount(count)} more ${count === 1 ? "ad does" : "ads do"} the same thing:`,
    othersSpend: (spend: string) => `${spend} this week`,
  },

  untagged: {
    figures: (taggedShare: string, minShare: string) =>
      `${taggedShare} of active Meta spend is fully tagged · the line is ${minShare}.`,
    spend: (untagged: string, total: string) =>
      `${untagged} of ${total} ran on ads we can't place.`,
  },

  drift: {
    offenders: "Where it is coming from:",
    offenderName: (name: string | null, raw: string | null) =>
      name ?? (raw ? `link tag "${raw}"` : "an ad we can't name"),
    offenderOrders: (orderCount: number) =>
      `${formatCount(orderCount)} ${orderCount === 1 ? "order" : "orders"}`,
    methodName: "matched by name",
    methodUnmatched: "matched nothing",
    samples: "The tags we received:",
    sample: (value: string, count: number) =>
      `${value} · ${formatCount(count)}×`,
    fix: "The template should read utm_content={{ad.id}} — check the campaign's URL parameters in Ads Manager.",
  },
};

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

    // Both land on the screens built for them: the funnel-stage slice, where
    // the mismatch is visible against every other stage, and the queue that
    // ranks the untagged ads by the money riding on them.
    case "ad_lp_funnel_mismatch":
      return {
        kind: "link",
        label: "See it against every stage →",
        href: "/insights?slice=funnelStage",
      };

    case "untagged_spend":
      return {
        kind: "link",
        label: "Open the tagging queue →",
        href: "/insights/tagging-queue",
      };

    /**
     * §8 wants the orders themselves, not a summary: the drifting tags are
     * only legible order by order. The payload's day drives the range, so the
     * link lands on exactly the orders the rule counted.
     */
    case "utm_template_drift": {
      const orderCount = num(item.payload, "orderCount");
      const day = str(item.payload, "day");
      return {
        kind: "link",
        label:
          orderCount === null
            ? "See those orders →"
            : `See the ${formatCount(orderCount)} orders →`,
        href: day
          ? bucketOrdersUrl({ bucket: "meta", dateFrom: day })
          : links.metaVsShopify,
      };
    }
  }
}

/** Only a connection finding can be re-run; the other two act on any row. */
export function canRerun(item: FindingItem): boolean {
  return item.type === "sync_failure";
}
