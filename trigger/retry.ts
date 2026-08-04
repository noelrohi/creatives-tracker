/**
 * One retry policy for the attribution tasks: a throttled Shopify Admin API, a
 * rate-limited Graph API and a busy Postgres are all transient, and three tries
 * with a widening gap covers every one of them.
 */
export const ATTRIBUTION_TASK_RETRY = {
  maxAttempts: 3,
  factor: 2,
  minTimeoutInMs: 5000,
  maxTimeoutInMs: 60000,
};

export const KLAVIYO_TASK_RETRY = {
  maxAttempts: 3,
  factor: 2,
  minTimeoutInMs: 5000,
  maxTimeoutInMs: 60000,
};
