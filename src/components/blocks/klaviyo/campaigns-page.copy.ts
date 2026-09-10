export const campaignsPage = {
  title: "Klaviyo campaigns",
  freshness: (publishedAgo: string) => `matches published ${publishedAgo}`,
  openLab: "Open lab",
  refresh: "Refresh report",
  refreshQueued: "Report refresh queued",
  refreshFresh: "Reports already fresh",
  refreshFailed: "Report refresh could not start",
  refreshHint: "Ask an admin to refresh the report.",
  timezoneLabel: (timezone: string) => `Send dates use ${timezone} account days`,
  emptyTitle: "No Klaviyo connection for this organization",
  emptyBody:
    "The Klaviyo pilot is bound to one store; ask an admin if you expected data here.",
  error: "Couldn’t load Klaviyo.",
  retry: "Retry",
} as const;
