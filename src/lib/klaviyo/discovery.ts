import "server-only";

import { parseIdentityHmacKeyring } from "@/lib/identity-hmac";
import {
  KlaviyoApiClient,
  type KlaviyoCompoundPage,
  type KlaviyoResource,
} from "@/lib/klaviyo/client";
import {
  EnvironmentKlaviyoCredentialProvider,
  type KlaviyoCredentialProvider,
} from "@/lib/klaviyo/credential-provider";
import {
  commitKlaviyoDiscovery,
  getConnectionRecord,
  prepareKlaviyoOperationRun,
  renewKlaviyoSyncRunHeartbeat,
} from "@/lib/klaviyo/source-store";
import {
  KLAVIYO_ORDER_CORE_KINDS,
  type KlaviyoConnectionScope,
  type KlaviyoMetricKind,
} from "@/lib/klaviyo/types";

const MAX_METRIC_PAGES = 200;

export type DiscoveredMetric = {
  id: string;
  name: string;
  integrationName: string | null;
  integrationCategory: string | null;
};

type NativeOrderKind = (typeof KLAVIYO_ORDER_CORE_KINDS)[number];

const METRIC_NAME_KINDS: ReadonlyMap<string, KlaviyoMetricKind> = new Map([
  ["Placed Order", "placed_order"],
  ["Ordered Product", "ordered_product"],
  ["Clicked Email", "clicked_email"],
  ["Clicked SMS", "clicked_sms"],
  ["Active on Site", "active_on_site"],
  ["Viewed Product", "viewed_product"],
  ["Added to Cart", "added_to_cart"],
  ["Checkout Started", "checkout_started"],
]);

const NATIVE_ORDER_KIND_LABELS: Record<NativeOrderKind, string> = {
  placed_order: "Placed Order",
  ordered_product: "Ordered Product",
};

function normalizedIntegrationName(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function classifyMetric(
  metric: DiscoveredMetric,
): KlaviyoMetricKind | null {
  const kind = METRIC_NAME_KINDS.get(metric.name.trim()) ?? null;
  if (kind === null) return null;
  if (KLAVIYO_ORDER_CORE_KINDS.includes(kind as never)) {
    return normalizedIntegrationName(metric.integrationName) === "shopify"
      ? kind
      : null;
  }
  return kind;
}

export function requireUniqueNativeOrderMetrics(
  metrics: DiscoveredMetric[],
): Record<NativeOrderKind, string> {
  const byKind = new Map<NativeOrderKind, string[]>(
    KLAVIYO_ORDER_CORE_KINDS.map((kind) => [kind, []]),
  );
  for (const metric of metrics) {
    const kind = classifyMetric(metric);
    if (kind !== null && byKind.has(kind as NativeOrderKind)) {
      byKind.get(kind as NativeOrderKind)!.push(metric.id);
    }
  }
  const result = {} as Record<NativeOrderKind, string>;
  for (const kind of KLAVIYO_ORDER_CORE_KINDS) {
    const ids = byKind.get(kind)!;
    if (ids.length !== 1) {
      throw new Error(
        `Expected exactly one Shopify-native ${NATIVE_ORDER_KIND_LABELS[kind]} metric`,
      );
    }
    result[kind] = ids[0];
  }
  return result;
}

type DiscoveryClient = Pick<KlaviyoApiClient, "listAccounts" | "listMetrics">;

type DiscoveryServices = {
  credentialProvider?: KlaviyoCredentialProvider;
  clientFactory?: (privateApiKey: string) => DiscoveryClient;
  loadIdentityKeyring?: () => unknown;
  loadConnection?: typeof getConnectionRecord;
  renewHeartbeat?: typeof renewKlaviyoSyncRunHeartbeat;
  commitDiscovery?: typeof commitKlaviyoDiscovery;
  now?: () => Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function accountMetadata(resource: KlaviyoResource): {
  name: string | null;
  timezone: string | null;
  currency: string | null;
} {
  const attributes = isRecord(resource.attributes) ? resource.attributes : {};
  const contact = isRecord(attributes.contact_information)
    ? attributes.contact_information
    : {};
  return {
    name:
      optionalString(contact.organization_name) ??
      optionalString(attributes.name),
    timezone: optionalString(attributes.timezone),
    currency: optionalString(attributes.preferred_currency),
  };
}

function discoveredMetricsFromPage(page: KlaviyoCompoundPage): DiscoveredMetric[] {
  const metrics: DiscoveredMetric[] = [];
  for (const resource of page.data) {
    if (resource.type !== "metric") continue;
    const attributes = isRecord(resource.attributes) ? resource.attributes : {};
    const integration = isRecord(attributes.integration)
      ? attributes.integration
      : {};
    const name = optionalString(attributes.name);
    if (name === null) continue;
    metrics.push({
      id: resource.id,
      name,
      integrationName: optionalString(integration.name),
      integrationCategory: optionalString(integration.category),
    });
  }
  return metrics;
}

/**
 * Prepare exactly one running scoped discovery run. Both secrets are
 * validated before any database write so misconfiguration cannot leave a
 * prepared row behind.
 */
export async function prepareKlaviyoDiscoveryRun(input: {
  scope: KlaviyoConnectionScope;
  triggerType: string;
  now: Date;
  credentialProvider?: KlaviyoCredentialProvider;
  loadIdentityKeyring?: () => unknown;
  prepareRun?: typeof prepareKlaviyoOperationRun;
}): Promise<{ syncRunId: string; reused: boolean }> {
  (input.loadIdentityKeyring ?? parseIdentityHmacKeyring)();
  const credentialProvider =
    input.credentialProvider ?? new EnvironmentKlaviyoCredentialProvider();
  await credentialProvider.getPilotBinding();
  return (input.prepareRun ?? prepareKlaviyoOperationRun)({
    scope: input.scope,
    operation: "discovery",
    triggerType: input.triggerType,
    requestParameters: {},
    now: input.now,
  });
}

export async function runKlaviyoDiscovery(
  input: {
    scope: KlaviyoConnectionScope;
    syncRunId: string;
  } & DiscoveryServices,
): Promise<{
  scope: KlaviyoConnectionScope;
  accountId: string;
  metricCount: number;
  orderMetricIds: Record<NativeOrderKind, string>;
}> {
  // Secrets fail before any remote call, client construction, or write.
  (input.loadIdentityKeyring ?? parseIdentityHmacKeyring)();

  const loadConnection = input.loadConnection ?? getConnectionRecord;
  const connection = await loadConnection(input.scope);
  if (!connection) {
    throw new Error("Klaviyo connection is outside this scope");
  }

  const credentialProvider =
    input.credentialProvider ?? new EnvironmentKlaviyoCredentialProvider();
  const credential = await credentialProvider.resolve({
    connectionId: connection.connectionId,
    credentialReference: connection.credentialReference,
    persistedKlaviyoAccountId: connection.klaviyoAccountId,
    shopDomain: connection.shopDomain,
  });

  const renewHeartbeat = input.renewHeartbeat ?? renewKlaviyoSyncRunHeartbeat;
  const now = input.now ?? (() => new Date());
  // Resolves the prepared scoped run: throws unless it is a running
  // discovery run inside this exact scope.
  await renewHeartbeat({
    scope: input.scope,
    syncRunId: input.syncRunId,
    operation: "discovery",
    now: now(),
  });

  const client = (
    input.clientFactory ??
    ((privateApiKey: string) => new KlaviyoApiClient({ privateApiKey }))
  )(credential.privateApiKey);

  const accountsPage = await client.listAccounts();
  const matchingAccounts = accountsPage.data.filter(
    (resource) =>
      resource.type === "account" &&
      resource.id === credential.expectedAccountId,
  );
  if (matchingAccounts.length !== 1) {
    throw new Error(
      "Discovered Klaviyo account does not match the Reviv binding",
    );
  }
  const account = matchingAccounts[0];

  const discovered: DiscoveredMetric[] = [];
  let metricsApiRevision: string | null = null;
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await client.listMetrics(cursor);
    metricsApiRevision = page.apiRevision;
    discovered.push(...discoveredMetricsFromPage(page));
    cursor = page.nextCursor;
    pages += 1;
    if (pages > MAX_METRIC_PAGES) {
      throw new Error("Klaviyo metric discovery exceeded the page bound");
    }
    await renewHeartbeat({
      scope: input.scope,
      syncRunId: input.syncRunId,
      operation: "discovery",
      now: now(),
    });
  } while (cursor !== null);

  const orderMetricIds = requireUniqueNativeOrderMetrics(discovered);
  const enabledMetricIds = new Set<string>(Object.values(orderMetricIds));
  const allowlisted = discovered
    .map((metric) => ({ metric, canonicalKind: classifyMetric(metric) }))
    .filter(
      (entry): entry is { metric: DiscoveredMetric; canonicalKind: KlaviyoMetricKind } =>
        entry.canonicalKind !== null,
    );

  const commit = input.commitDiscovery ?? commitKlaviyoDiscovery;
  await commit({
    scope: input.scope,
    syncRunId: input.syncRunId,
    expectedAccountId: credential.expectedAccountId,
    account: {
      id: account.id,
      ...accountMetadata(account),
    },
    metrics: allowlisted.map(({ metric, canonicalKind }) => ({
      externalMetricId: metric.id,
      name: metric.name,
      integrationName: metric.integrationName,
      integrationCategory: metric.integrationCategory,
      canonicalKind,
      ingestionEnabled: enabledMetricIds.has(metric.id),
      apiRevision: metricsApiRevision ?? "unknown",
    })),
  });

  return {
    scope: input.scope,
    accountId: account.id,
    metricCount: allowlisted.length,
    orderMetricIds,
  };
}
