// Tab order: the two summary views first, then the evidence ledgers.
export const LAB_VIEWS = [
  "ledger",
  "list-health",
  "orders",
  "unmatched",
  "probe",
] as const;
export const LAB_RANGES = ["last7", "last30", "last90", "custom"] as const;
export const ORDER_STATUS_FILTERS = [
  "all",
  "confirmed",
  "candidate",
  "ambiguous",
  "no_klaviyo_event",
  "duplicate_conversion_events",
  "not_evaluated",
] as const;
export const PRODUCT_STATUS_FILTERS = [
  "all",
  "exact",
  "partial",
  "contradictory",
  "unavailable",
] as const;
export const CLAIM_TYPE_FILTERS = [
  "all",
  "campaign",
  "flow",
  "message",
  "interaction",
  "none",
] as const;
export const CHANNEL_FILTERS = ["all", "email", "sms", "onsite", "unknown"] as const;
export const DETAIL_TABS = [
  "explanation",
  "products",
  "journey",
  "claims",
  "inspector",
] as const;
export const JOURNEY_LOOKBACKS = [7, 30, 90] as const;

export type LabView = (typeof LAB_VIEWS)[number];
export type LabRange = (typeof LAB_RANGES)[number];
export type OrderStatusFilter = (typeof ORDER_STATUS_FILTERS)[number];
export type ProductStatusFilter = (typeof PRODUCT_STATUS_FILTERS)[number];
export type ClaimTypeFilter = (typeof CLAIM_TYPE_FILTERS)[number];
export type ChannelFilter = (typeof CHANNEL_FILTERS)[number];
export type DetailTab = (typeof DETAIL_TABS)[number];
export type JourneyLookback = (typeof JOURNEY_LOOKBACKS)[number];

export const LEDGER_KIND_FILTERS = ["all", "campaign", "flow"] as const;
export const LEDGER_CHANNEL_FILTERS = ["all", "email", "sms"] as const;
export type LedgerKindFilter = (typeof LEDGER_KIND_FILTERS)[number];
export type LedgerChannelFilter = (typeof LEDGER_CHANNEL_FILTERS)[number];

export const ledgerTimezoneLabel = (timezone: string) =>
  `Send dates use ${timezone} account days`;

/** Mirrors KLAVIYO_REPORT_KINDS for the browser (reports.ts is server-side). */
export const LEDGER_REFRESH_KINDS = [
  "campaign",
  "flow",
  "campaign_message",
  "flow_message",
] as const;

export const ADVISORY_BANNER =
  "Advisory evidence only — production attribution stays unchanged.";

export const ORDER_STATUS_LABELS: Record<OrderStatusFilter, string> = {
  all: "All orders",
  confirmed: "Confirmed",
  candidate: "Candidate",
  ambiguous: "Ambiguous",
  no_klaviyo_event: "No Klaviyo event",
  duplicate_conversion_events: "Duplicate conversions",
  not_evaluated: "Not evaluated",
};

export const EVENT_STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  candidate: "Candidate",
  ambiguous: "Ambiguous",
  unmatched: "Unmatched",
  not_evaluated: "Not evaluated",
};

export const emailRevenue = {
  title: "Email revenue · Klaviyo",
  freshness: (publishedAgo: string) => `matches published ${publishedAgo}`,
  netSales: "Shopify net sales",
  linked: (percent: string, orders: number) =>
    `Tied to email · ${percent} · ${orders} order${orders === 1 ? "" : "s"}`,
  coverage: (covered: string, total: string) => `${covered}/${total} checked`,
  says: "Klaviyo says",
  saysUnconfirmed: (amount: string) => `+${amount} unconfirmed`,
  saysWindow: (range: string) => `their ${range} report`,
  saysWindowNote:
    "“Klaviyo says” is their report over each campaign’s own window, not this date range",
  segCampaigns: (amount: string) => `Campaigns ${amount}`,
  segFlows: (amount: string) => `Flows ${amount}`,
  segRest: (amount: string) => `Everything else ${amount}`,
  sourcesHeading: "By campaign & flow — we confirm vs Klaviyo says",
  productsHeading: "Top products in email-linked orders",
  productsMore: (n: number) => `…${n} more`,
  productsRevenueNote:
    "Order revenue: net sales of email-linked orders containing the product; an order with several products counts toward each",
  gapsLead: "Where the rest is:",
  gapNoEmailLink: (orders: number) =>
    `${orders} order${orders === 1 ? "" : "s"} had a Klaviyo event but no campaign/flow link`,
  gapClaimsPending: (orders: number) =>
    `${orders} order${orders === 1 ? "" : "s"} not checked for email links yet`,
  gapNotEvaluated: (orders: number) =>
    `${orders} not evaluated yet (newer than evidence)`,
  gapNoEvent: (orders: number) =>
    `${orders} with no Klaviyo event at all`,
  gapDuplicates: (orders: number) =>
    `${orders} flagged for duplicate conversion events`,
  gapUnmatched: (count: number) =>
    `${count} Klaviyo event${count === 1 ? "" : "s"} matched no order`,
  noDataYet: "No data yet",
  error: "Couldn’t load email revenue.",
  retry: "Retry",
} as const;

/** ASCII "-" prefix for a nonnegative magnitude; never renders as "-0". */
function negated(n: number): string {
  return n === 0 ? `${n}` : `-${n}`;
}

export const listHealth = {
  stripLead: "List health:",
  subscribed: (n: number) => `+${n} subscribed`,
  unsubscribed: (n: number) => `${negated(n)} unsubscribed`,
  wonBack: (n: number) => `${n} won back`,
  quickChurn: (n: number) => `${n} quick churn`,
  net: (n: number) => `net ${n >= 0 ? `+${n}` : `${n}`}`,
  kpiSubscribed: "Subscribed",
  kpiUnsubscribed: "Unsubscribed",
  kpiWonBack: "Won back",
  kpiQuickChurn: "Quick churn (≤14d)",
  kpiNet: "Net",
  barsCaption: "Daily net (green in / red out), page range",
  aggregateNote:
    "Aggregate counts only — no per-person rows; list-membership semantics (a person on two lists counts once per list)",
  undiscovered:
    "Run discovery to enable list tracking — the consent metrics haven't been synced for this connection yet.",
  error: "Couldn’t load list health.",
} as const;

export const ledger = {
  tab: "Campaigns",
  caption: (timezone: string, from: string, to: string) =>
    `Send dates use ${timezone} account days · ${from} → ${to}`,
  asOf: (iso: string) => `as of ${iso}`,
  refresh: "Refresh report",
  noReport: "No report for this range yet",
  noRows: "No campaigns or flows in this range",
  noResults: "No results match your filters",
  clearFilters: "Clear filters",
  error: "Couldn’t load campaigns.",
  retry: "Retry",
  ongoing: "ongoing",
  loadingMessages: "Loading messages",
  noMessages: "No messages",
  messagesError: "Couldn’t load messages.",
  columns: {
    name: "Name",
    sent: "Sent",
    recipients: "Recipients",
    delivered: "Delivered",
    open: "Open",
    click: "Click",
    orders: "Orders",
    revenue: "We confirm",
    klaviyoSays: "Klaviyo says",
    unsub: "Unsub",
  },
  chips: { campaign: "CMP", flow: "FLW", email: "EMAIL", sms: "SMS" },
  sourceFilter: "Filtered to one campaign or flow",
  clearSource: "Show all orders",
  sheet: {
    title: "Campaign detail",
    advisory: "Advisory evidence only",
    sentAt: (day: string) => `Sent ${day}`,
    subject: (subject: string) => `Subject: “${subject}”`,
    funnel: "Funnel",
    recipients: "recipients",
    delivered: "delivered",
    opened: "opened",
    clicked: "clicked",
    ordered: "ordered ✓",
    revenue: "Revenue",
    weConfirm: "We confirm",
    weConfirmNote: (orders: number) => `${orders} order${orders === 1 ? "" : "s"}, refund-net`,
    klaviyoSays: "Klaviyo says",
    unconfirmed: (orders: number) => `${orders} order${orders === 1 ? "" : "s"} we couldn’t confirm`,
    perRecipient: "Per recipient",
    aov: (amount: string) => `AOV ${amount}`,
    listImpact: "List impact",
    unsubscribed: "Unsubscribed",
    spam: "Spam complaints",
    bounced: "Bounced",
    ordersByDayOffset: "Confirmed orders by day after send",
    ordersByDayCalendar: "Confirmed orders by day",
    // No count: the orders view keeps its own date window and confirmed-only
    // filter, so it cannot promise the sheet's number.
    viewOrders: "View orders in Orders →",
    topProducts: "Top products",
    variants: "Variants (A/B)",
    emails: "Emails in this flow",
    loading: "Loading campaign detail",
    error: "Couldn’t load this campaign.",
  },
} as const;
