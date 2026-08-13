export type GoogleAdsScope = {
  organizationId: string;
  storeId: string;
  connectionId: string;
};

export type ClickIdKind = "gclid" | "wbraid" | "gbraid";

export type GclidProbeBucketCell = {
  orders: number;
  withClickId: number;
};

export type GclidProbeParamFingerprint = {
  /** Literal key when allowlisted, otherwise `sha256:<12 hex chars>`. */
  key: string;
  hashed: boolean;
  count: number;
};

export type GclidProbeSummary = {
  ordersScanned: number;
  ordersWithAnyClickId: number;
  byKind: Record<ClickIdKind, number>;
  /** Keyed by production bucket name; unbucketed orders land in "pending". */
  byBucket: Record<string, GclidProbeBucketCell>;
  /** customerJourney null, not ready, or lastVisit absent. */
  journeyMissing: number;
  /** URLs present but unparseable even by the query-string fallback. */
  parseFailures: number;
  /** Orders carrying more than one click-ID kind. */
  multiKindOrders: number;
  paramKeyFingerprints: GclidProbeParamFingerprint[];
};
