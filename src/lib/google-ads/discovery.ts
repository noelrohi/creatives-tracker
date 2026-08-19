import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { googleAdsConnections, googleAdsSyncRuns } from "@/schema/google-ads";
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
  // Fail closed: a missing or non-boolean `manager` field is treated as
  // malformed rather than assumed non-manager.
  if (typeof customer.manager !== "boolean") {
    return { ok: false, code: "malformed_customer" };
  }
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
  // Guards against a stale re-dispatch (e.g. a duplicated Trigger.dev
  // invocation) acting on a run that already reached a terminal state —
  // without this a late retry could flip an already-degraded connection
  // back to ready off of a completed/failed run.
  if (run.status !== "running") {
    throw new Error("Google Ads discovery run is not running");
  }
  const provider = params.provider ?? new EnvironmentGoogleAdsCredentialProvider();
  const [connection] = await db
    .select()
    .from(googleAdsConnections)
    .where(eq(googleAdsConnections.id, scope.connectionId))
    .limit(1);
  if (!connection) throw new Error("Google Ads connection does not exist");

  // Both writes below (the run's terminal state and the connection's
  // status) must land together — a crash between two separate statements
  // could otherwise leave a "failed" run pointing at a "ready" connection,
  // or vice versa.
  const degrade = async (error: SanitizedSyncError) => {
    await db.transaction(async (tx) => {
      await tx
        .update(googleAdsSyncRuns)
        .set({
          status: "failed",
          errorCode: error.code,
          errorMessage: error.message,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(googleAdsSyncRuns.id, params.syncRunId),
            eq(googleAdsSyncRuns.organizationId, scope.organizationId),
            eq(googleAdsSyncRuns.storeId, scope.storeId),
            eq(googleAdsSyncRuns.connectionId, scope.connectionId),
            eq(googleAdsSyncRuns.operation, "discovery"),
            eq(googleAdsSyncRuns.status, "running"),
          ),
        );
      await tx
        .update(googleAdsConnections)
        .set({ status: "degraded" })
        .where(eq(googleAdsConnections.id, scope.connectionId));
    });
    return { status: "degraded" as const, code: error.code };
  };

  // Pre-flight: a credential-resolution failure (missing/invalid env
  // configuration, a persisted-customer-id mismatch) must never leave the
  // run stuck in "running" — that would wedge the partial unique index
  // that allows only one running discovery run per connection. The caught
  // error's message is never surfaced: even though today's failures are
  // just missing env var names, the sanitized-error boundary must stay
  // absolute regardless of what a provider implementation might throw.
  let credential: ResolvedGoogleAdsCredential;
  try {
    credential = await provider.resolve({
      credentialReference: GOOGLE_ADS_CREDENTIAL_REFERENCE,
      persistedGoogleCustomerId: connection.googleCustomerId,
    });
  } catch {
    return degrade({
      code: "credential_invalid",
      message: "Google Ads credential configuration is invalid",
    });
  }
  const client =
    params.clientFactory?.(credential) ?? new GoogleAdsClient({ credential });

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

  // Fail closed on a currency change (spec §12): once a connection has a
  // recorded currency, discovery must not silently repoint historical
  // facts at a new currency — that would misrepresent past cost/revenue.
  if (
    connection.currencyCode !== null &&
    connection.currencyCode !== evaluation.customer.currencyCode
  ) {
    return degrade({
      code: "currency_changed",
      message: "Google Ads account currency changed since last discovery",
    });
  }

  // Ready flip and run completion commit atomically: a crash between the
  // two writes could otherwise leave a ready connection with a permanently
  // running discovery run wedging the one-running partial unique index.
  await db.transaction(async (tx) => {
    await tx
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
    await completeGoogleAdsSyncRun(
      {
        scope,
        syncRunId: params.syncRunId,
        operation: "discovery",
      },
      tx,
    );
  });
  return { status: "ready" };
}
