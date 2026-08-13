import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { googleAdsConnections } from "@/schema/google-ads";
import {
  GoogleAdsClient,
  GoogleAdsApiError,
} from "@/lib/google-ads/client";
import {
  EnvironmentGoogleAdsCredentialProvider,
  GOOGLE_ADS_CREDENTIAL_REFERENCE,
  type GoogleAdsCredentialProvider,
  type ResolvedGoogleAdsCredential,
} from "@/lib/google-ads/credential-provider";
import { buildCustomerQuery } from "@/lib/google-ads/facts";
import {
  completeGoogleAdsSyncRun,
  failGoogleAdsSyncRun,
  resolveGoogleAdsSyncRun,
  type SanitizedSyncError,
} from "@/lib/google-ads/sync-store";

export type DiscoveredCustomer = {
  googleCustomerId: string;
  descriptiveName: string | null;
  currencyCode: string | null;
  timezone: string | null;
};

export type DiscoveryEvaluation =
  | { ok: true; customer: DiscoveredCustomer }
  | { ok: false; code: "malformed_customer" | "manager_account" | "customer_mismatch" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function evaluateDiscoveryRow(
  row: Record<string, unknown>,
  expectedCustomerId: string,
): DiscoveryEvaluation {
  const customer = isRecord(row.customer) ? row.customer : null;
  const rawId =
    customer && (typeof customer.id === "string" || typeof customer.id === "number")
      ? String(customer.id)
      : null;
  if (!customer || !rawId) return { ok: false, code: "malformed_customer" };
  if (customer.manager === true) return { ok: false, code: "manager_account" };
  if (rawId !== expectedCustomerId) return { ok: false, code: "customer_mismatch" };
  return {
    ok: true,
    customer: {
      googleCustomerId: rawId,
      descriptiveName:
        typeof customer.descriptiveName === "string" ? customer.descriptiveName : null,
      currencyCode:
        typeof customer.currencyCode === "string" ? customer.currencyCode : null,
      timezone: typeof customer.timeZone === "string" ? customer.timeZone : null,
    },
  };
}

export function sanitizeGoogleAdsError(error: unknown): SanitizedSyncError {
  if (error instanceof GoogleAdsApiError) {
    return {
      code: error.retryable ? "provider_unavailable" : "provider_rejected",
      message: error.message,
    };
  }
  return { code: "internal_error", message: "Google Ads sync failed unexpectedly" };
}

/**
 * Discovery: validate the configured customer account and mark the pilot
 * connection ready (or degraded on a deterministic mismatch). A retryable
 * provider failure escapes so the durable task retries it.
 */
export async function runGoogleAdsDiscovery(params: {
  syncRunId: string;
  provider?: GoogleAdsCredentialProvider;
  clientFactory?: (
    credential: ResolvedGoogleAdsCredential,
  ) => Pick<GoogleAdsClient, "search">;
}): Promise<{ status: "ready" | "degraded"; code?: string }> {
  const { run, scope } = await resolveGoogleAdsSyncRun(params.syncRunId);
  if (run.operation !== "discovery") {
    throw new Error("Google Ads discovery run has the wrong operation");
  }
  const provider = params.provider ?? new EnvironmentGoogleAdsCredentialProvider();
  const [connection] = await db
    .select()
    .from(googleAdsConnections)
    .where(eq(googleAdsConnections.id, scope.connectionId))
    .limit(1);
  if (!connection) throw new Error("Google Ads connection does not exist");

  const credential = await provider.resolve({
    credentialReference: GOOGLE_ADS_CREDENTIAL_REFERENCE,
    persistedGoogleCustomerId: connection.googleCustomerId,
  });
  const client =
    params.clientFactory?.(credential) ?? new GoogleAdsClient({ credential });

  const degrade = async (error: SanitizedSyncError) => {
    await failGoogleAdsSyncRun({
      scope,
      syncRunId: params.syncRunId,
      operation: "discovery",
      error,
    });
    await db
      .update(googleAdsConnections)
      .set({ status: "degraded" })
      .where(eq(googleAdsConnections.id, scope.connectionId));
    return { status: "degraded" as const, code: error.code };
  };

  let evaluation: DiscoveryEvaluation;
  try {
    const page = await client.search({ query: buildCustomerQuery() });
    evaluation = page.results[0]
      ? evaluateDiscoveryRow(page.results[0], credential.customerId)
      : { ok: false, code: "malformed_customer" };
  } catch (error) {
    if (error instanceof GoogleAdsApiError && error.retryable) throw error;
    return degrade(sanitizeGoogleAdsError(error));
  }

  if (!evaluation.ok) {
    return degrade({
      code: evaluation.code,
      message: `Google Ads discovery rejected: ${evaluation.code}`,
    });
  }

  await db
    .update(googleAdsConnections)
    .set({
      googleCustomerId: evaluation.customer.googleCustomerId,
      descriptiveName: evaluation.customer.descriptiveName,
      currencyCode: evaluation.customer.currencyCode,
      timezone: evaluation.customer.timezone,
      status: "ready",
      lastDiscoverySyncedAt: new Date(),
    })
    .where(eq(googleAdsConnections.id, scope.connectionId));
  await completeGoogleAdsSyncRun({
    scope,
    syncRunId: params.syncRunId,
    operation: "discovery",
  });
  return { status: "ready" };
}
