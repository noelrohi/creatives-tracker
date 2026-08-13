import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { googleAdsConnections } from "@/schema/google-ads";
import {
  GoogleAdsClient,
  GOOGLE_ADS_API_VERSION,
  type GoogleAdsSearchPage,
} from "@/lib/google-ads/client";
import {
  EnvironmentGoogleAdsCredentialProvider,
  GOOGLE_ADS_CREDENTIAL_REFERENCE,
  type GoogleAdsCredentialProvider,
  type ResolvedGoogleAdsCredential,
} from "@/lib/google-ads/credential-provider";
import {
  addDays,
  buildCampaignFactsQuery,
  normalizeCampaignFactRow,
  type NormalizedCampaignFact,
} from "@/lib/google-ads/facts";
import {
  commitCampaignFactsChunk,
  completeGoogleAdsSyncRun,
  createGoogleAdsSyncRun,
  getPilotGoogleAdsConnectionForOrganization,
  connectionScope,
  resolveGoogleAdsSyncRun,
  type SyncRunRecord,
} from "@/lib/google-ads/sync-store";

/** ≤14 account-days per batch invocation keeps each run far inside maxDuration. */
const CHUNK_DAYS = 14;

export type FactsChunk = { fromDay: string; toDay: string; done: boolean };

export function nextChunk(run: {
  windowFromDay: string;
  windowToDay: string;
  checkpointDay: string | null;
}): FactsChunk | null {
  const fromDay = run.checkpointDay
    ? addDays(run.checkpointDay, 1)
    : run.windowFromDay;
  if (fromDay > run.windowToDay) return null;
  const candidateTo = addDays(fromDay, CHUNK_DAYS - 1);
  const toDay = candidateTo < run.windowToDay ? candidateTo : run.windowToDay;
  return { fromDay, toDay, done: toDay === run.windowToDay };
}

/**
 * Creates a facts run for an inclusive account-day window. The caller
 * (tRPC mutation or nightly schedule) then triggers the batch task.
 *
 * NOTE: `getPilotGoogleAdsConnectionForOrganization` is org-scoped with
 * `limit(1)` and no `ORDER BY` — nondeterministic if an org ever has more
 * than one store connected. Acceptable for the single-store pilot; flagged
 * here rather than changed, since sync-store.ts is out of scope for this
 * task.
 */
export async function prepareGoogleAdsFactsRun(params: {
  organizationId: string;
  windowFromDay: string;
  windowToDay: string;
}): Promise<SyncRunRecord> {
  const connection = await getPilotGoogleAdsConnectionForOrganization(
    params.organizationId,
  );
  if (!connection) throw new Error("Google Ads pilot connection is not configured");
  if (connection.status !== "ready") {
    throw new Error("Google Ads connection is not ready; run discovery first");
  }
  return createGoogleAdsSyncRun({
    scope: connectionScope(connection),
    operation: "facts",
    windowFromDay: params.windowFromDay,
    windowToDay: params.windowToDay,
    apiVersion: GOOGLE_ADS_API_VERSION,
  });
}

/**
 * Processes ONE chunk (≤14 days, all its pages) and commits it atomically.
 * Returns done=false when the task should self-chain for the next chunk.
 * A re-dispatch against an already-terminal run returns done=true without
 * touching anything (Trigger.dev retries re-enter here safely).
 */
export async function processGoogleAdsFactsBatch(params: {
  syncRunId: string;
  provider?: GoogleAdsCredentialProvider;
  clientFactory?: (
    credential: ResolvedGoogleAdsCredential,
  ) => Pick<GoogleAdsClient, "search">;
}): Promise<{ done: boolean; chunk: FactsChunk | null; rowsRead: number }> {
  const { run, scope } = await resolveGoogleAdsSyncRun(params.syncRunId);
  if (run.operation !== "facts" || !run.windowFromDay || !run.windowToDay) {
    throw new Error("Google Ads facts run is malformed");
  }
  if (run.status !== "running") {
    return { done: true, chunk: null, rowsRead: 0 };
  }
  const chunk = nextChunk({
    windowFromDay: run.windowFromDay,
    windowToDay: run.windowToDay,
    checkpointDay: run.checkpointDay,
  });
  if (!chunk) {
    await completeGoogleAdsSyncRun({ scope, syncRunId: run.id, operation: "facts" });
    return { done: true, chunk: null, rowsRead: 0 };
  }

  const [connection] = await db
    .select({ currencyCode: googleAdsConnections.currencyCode })
    .from(googleAdsConnections)
    .where(eq(googleAdsConnections.id, scope.connectionId))
    .limit(1);
  if (!connection) {
    throw new Error("Google Ads connection does not exist for this sync run's scope");
  }

  const provider = params.provider ?? new EnvironmentGoogleAdsCredentialProvider();
  const credential = await provider.resolve({
    credentialReference: GOOGLE_ADS_CREDENTIAL_REFERENCE,
    persistedGoogleCustomerId: null,
  });
  const client =
    params.clientFactory?.(credential) ?? new GoogleAdsClient({ credential });

  const query = buildCampaignFactsQuery(chunk.fromDay, chunk.toDay);
  const facts: NormalizedCampaignFact[] = [];
  let rowsRead = 0;
  let failureCount = 0;
  let pageToken: string | null = null;
  do {
    const page: GoogleAdsSearchPage = await client.search({ query, pageToken });
    for (const row of page.results) {
      rowsRead += 1;
      const fact = normalizeCampaignFactRow(row);
      if (fact) facts.push(fact);
      else failureCount += 1;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  await commitCampaignFactsChunk({
    scope,
    syncRunId: run.id,
    facts,
    checkpointDay: chunk.toDay,
    rowsRead,
    failureCount,
    currencyCode: connection.currencyCode,
    apiVersion: GOOGLE_ADS_API_VERSION,
  });
  if (chunk.done) {
    await completeGoogleAdsSyncRun({ scope, syncRunId: run.id, operation: "facts" });
  }
  return { done: chunk.done, chunk, rowsRead };
}
