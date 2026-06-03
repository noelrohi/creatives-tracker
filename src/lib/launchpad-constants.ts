export const LAUNCHPAD_MAX_ITEMS = 25;

export const launchpadRunStatuses = [
  "validation",
  "validated",
  "queued",
  "publishing",
  "success",
  "partial_success",
  "failed",
  "ambiguous",
  "skipped",
  "cancelled",
  "manual_intervention",
] as const;

export type LaunchpadRunStatus = (typeof launchpadRunStatuses)[number];

export const launchpadItemStatuses = [
  "validation",
  "validated",
  "queued",
  "publishing",
  "success",
  "partial_success",
  "failed",
  "ambiguous",
  "skipped",
  "cancelled",
  "manual_intervention",
] as const;

export type LaunchpadItemStatus = (typeof launchpadItemStatuses)[number];

export const launchpadErrorCategories = [
  "retryable",
  "terminal",
  "ambiguous",
  "manual_intervention",
] as const;

export type LaunchpadErrorCategory = (typeof launchpadErrorCategories)[number];

export const launchpadReconciliationStatuses = [
  "not_required",
  "pending",
  "checking",
  "reconciled",
  "mismatched",
  "manual_intervention",
] as const;

export type LaunchpadReconciliationStatus =
  (typeof launchpadReconciliationStatuses)[number];

export const launchpadPrincipalTypes = [
  "session",
  "apiKey",
  "worker",
  "anonymous",
] as const;

export type LaunchpadPrincipalType = (typeof launchpadPrincipalTypes)[number];

export const metaCtaValues = [
  "SHOP_NOW",
  "LEARN_MORE",
  "SIGN_UP",
  "SUBSCRIBE",
  "CONTACT_US",
  "GET_QUOTE",
  "APPLY_NOW",
  "DOWNLOAD",
  "BOOK_TRAVEL",
  "CALL_NOW",
  "NO_BUTTON",
] as const;

export type MetaCallToAction = (typeof metaCtaValues)[number];

export const DEFAULT_META_CTA = "SHOP_NOW" satisfies MetaCallToAction;
export const PAUSED_META_STATUS = "PAUSED";
