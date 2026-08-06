import "server-only";

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import type {
  KlaviyoConnectionScope,
  KlaviyoMetricKind,
} from "@/lib/klaviyo/types";
import { klaviyoEventRunObservations, klaviyoEvents, klaviyoSyncRuns } from "@/schema/klaviyo";

export type JourneyLookbackDays = 7 | 30 | 90;

export type JourneyEvent = {
  eventRowId: string;
  externalEventId: string;
  metricKind: KlaviyoMetricKind | null;
  occurredAt: Date;
  profileId: string | null;
  canonicallyIngested: boolean;
};

export type JourneyConversionEvent = {
  eventRowId: string;
  occurredAt: Date;
  profileId: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure exact-profile timeline construction. The conversion's stored
 * Klaviyo profile relationship ID is the only join: HMAC digests never
 * add an event, cross-profile events are rejected outright, and a profile
 * ID remains pseudonymous source evidence — never proof of a Shopify
 * person, hence the fixed `same_klaviyo_profile` label and merge caveat.
 */
export function buildOrderJourney(input: {
  conversion: JourneyConversionEvent;
  attributedInteraction: JourneyEvent | null;
  profileEvents: JourneyEvent[];
  lookbackDays: JourneyLookbackDays;
  ingestedFrom: Date;
}): {
  label: "same_klaviyo_profile";
  events: JourneyEvent[];
  clipped: boolean;
  caveats: string[];
} {
  if (![7, 30, 90].includes(input.lookbackDays)) {
    throw new Error("Klaviyo journey lookback is invalid");
  }
  if (input.conversion.profileId === null) {
    throw new Error("Klaviyo journey conversion has no profile relationship");
  }
  const caveats: string[] = ["profile_merge_possible"];
  const lookbackStart = new Date(
    input.conversion.occurredAt.getTime() - input.lookbackDays * DAY_MS,
  );
  const clipped = input.ingestedFrom.getTime() > lookbackStart.getTime();
  if (clipped) caveats.push("clipped_to_ingested_coverage");
  const effectiveStart = clipped ? input.ingestedFrom : lookbackStart;

  const candidates = [...input.profileEvents];
  if (input.attributedInteraction !== null) {
    if (!input.attributedInteraction.canonicallyIngested) {
      // A claim-time single-event fetch is not journey publication.
      caveats.push("attributed_interaction_not_canonical");
    } else {
      candidates.push(input.attributedInteraction);
    }
  }

  const seen = new Set<string>();
  const events: JourneyEvent[] = [];
  for (const event of candidates) {
    if (event.profileId !== input.conversion.profileId) {
      throw new Error(
        "Klaviyo journey events must share the exact conversion profile",
      );
    }
    if (!event.canonicallyIngested) continue;
    if (event.occurredAt.getTime() > input.conversion.occurredAt.getTime()) {
      continue;
    }
    if (event.occurredAt.getTime() < effectiveStart.getTime()) continue;
    if (seen.has(event.eventRowId)) continue;
    seen.add(event.eventRowId);
    events.push(event);
  }
  events.sort((left, right) => {
    const byTime = left.occurredAt.getTime() - right.occurredAt.getTime();
    if (byTime !== 0) return byTime;
    return left.eventRowId < right.eventRowId ? -1 : 1;
  });

  return { label: "same_klaviyo_profile", events, clipped, caveats };
}

export type CanonicalJourneyCoverage = {
  events: JourneyEvent[];
  ingestedFrom: Date | null;
};

/**
 * Load candidate journey events for one exact profile inside one
 * connection and bounded range. An event is eligible only through an
 * immutable observation owned by a terminal success journey run
 * (checkpoint null, immutable journey parameters); the latest successful
 * observation per event must equal the current event checksum. Rows
 * introduced or mutated only by partial/failed refreshes never surface,
 * and a newer successful checksum mismatch never falls back to an older
 * observation.
 */
export async function loadCanonicalJourneyEvents(input: {
  scope: KlaviyoConnectionScope;
  profileId: string;
  from: Date;
  to: Date;
}): Promise<CanonicalJourneyCoverage> {
  const successfulJourneyRun = and(
    eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
    eq(klaviyoSyncRuns.operation, "events"),
    eq(klaviyoSyncRuns.status, "success"),
    sql`${klaviyoSyncRuns.checkpoint} is null`,
    sql`${klaviyoSyncRuns.requestParameters}->>'sourceMode' = 'journey'`,
  );

  const rows = await db
    .select({
      eventRowId: klaviyoEvents.id,
      externalEventId: klaviyoEvents.externalEventId,
      occurredAt: klaviyoEvents.occurredAt,
      profileId: klaviyoEvents.profileId,
      sourceChecksum: klaviyoEvents.sourceChecksum,
      observedChecksum: klaviyoEventRunObservations.observedSourceChecksum,
      finishedAt: klaviyoSyncRuns.finishedAt,
      syncRunId: klaviyoSyncRuns.id,
    })
    .from(klaviyoEvents)
    .innerJoin(
      klaviyoEventRunObservations,
      and(
        eq(
          klaviyoEventRunObservations.connectionId,
          klaviyoEvents.connectionId,
        ),
        eq(klaviyoEventRunObservations.eventId, klaviyoEvents.id),
      ),
    )
    .innerJoin(
      klaviyoSyncRuns,
      and(
        eq(klaviyoSyncRuns.id, klaviyoEventRunObservations.syncRunId),
        successfulJourneyRun,
      ),
    )
    .where(
      and(
        eq(klaviyoEvents.organizationId, input.scope.organizationId),
        eq(klaviyoEvents.storeId, input.scope.storeId),
        eq(klaviyoEvents.connectionId, input.scope.connectionId),
        eq(klaviyoEvents.profileId, input.profileId),
        gte(klaviyoEvents.occurredAt, input.from),
        lt(klaviyoEvents.occurredAt, input.to),
      ),
    );

  // Latest successful observation per event by (finishedAt, syncRunId).
  const latestByEvent = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const existing = latestByEvent.get(row.eventRowId);
    if (
      !existing ||
      (row.finishedAt?.getTime() ?? 0) >
        (existing.finishedAt?.getTime() ?? 0) ||
      ((row.finishedAt?.getTime() ?? 0) ===
        (existing.finishedAt?.getTime() ?? 0) &&
        row.syncRunId > existing.syncRunId)
    ) {
      latestByEvent.set(row.eventRowId, row);
    }
  }

  const metricKinds = await journeyMetricKindsByEvent(
    input.scope,
    [...latestByEvent.keys()],
  );
  const events: JourneyEvent[] = [];
  for (const row of latestByEvent.values()) {
    if (row.observedChecksum !== row.sourceChecksum) continue;
    events.push({
      eventRowId: row.eventRowId,
      externalEventId: row.externalEventId,
      metricKind: metricKinds.get(row.eventRowId) ?? null,
      occurredAt: row.occurredAt,
      profileId: row.profileId,
      canonicallyIngested: true,
    });
  }

  const [coverage] = await db
    .select({ earliest: sql<string | null>`min(${klaviyoSyncRuns.requestedFrom})::text` })
    .from(klaviyoSyncRuns)
    .where(successfulJourneyRun);
  return {
    events,
    ingestedFrom:
      coverage?.earliest == null
        ? null
        : new Date(`${coverage.earliest.replace(" ", "T")}Z`),
  };
}

async function journeyMetricKindsByEvent(
  scope: KlaviyoConnectionScope,
  eventRowIds: string[],
): Promise<Map<string, KlaviyoMetricKind | null>> {
  if (eventRowIds.length === 0) return new Map();
  const { klaviyoMetrics } = await import("@/schema/klaviyo");
  const rows = await db
    .select({
      eventRowId: klaviyoEvents.id,
      canonicalKind: klaviyoMetrics.canonicalKind,
    })
    .from(klaviyoEvents)
    .innerJoin(
      klaviyoMetrics,
      and(
        eq(klaviyoMetrics.connectionId, klaviyoEvents.connectionId),
        eq(klaviyoMetrics.id, klaviyoEvents.metricId),
      ),
    )
    .where(
      and(
        eq(klaviyoEvents.connectionId, scope.connectionId),
        sql`${klaviyoEvents.id} in ${eventRowIds}`,
      ),
    );
  return new Map(rows.map((row) => [row.eventRowId, row.canonicalKind]));
}
