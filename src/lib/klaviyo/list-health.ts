import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { deriveDayInTimezone } from "@/lib/shopify-ingest";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";
import type { HalfOpenUtcWindow } from "@/lib/klaviyo/queries";
import { klaviyoEvents, klaviyoMetrics } from "@/schema/klaviyo";

/**
 * List-membership consent aggregates. Counts are event counts (a person on
 * two lists counts once per list — v1 semantics matching Klaviyo's own list
 * numbers); flips are per-profile transitions ordered by occurred_at, so
 * out-of-order ingestion self-corrects on the next read. Aggregate-only:
 * nothing per-profile leaves this module.
 */

export const QUICK_CHURN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type ConsentEventInput = {
  profileId: string | null;
  metricKind: "subscribed_to_list" | "unsubscribed_from_list";
  occurredAt: Date;
};

export type ListHealthDailyRow = {
  day: string;
  subscribed: number;
  unsubscribed: number;
  wonBack: number;
  quickChurn: number;
  net: number;
};

export type ListHealthSummary = {
  /** False when the consent metrics have not been discovered yet. */
  discovered: boolean;
  totals: {
    subscribed: number;
    unsubscribed: number;
    wonBack: number;
    quickChurn: number;
    net: number;
  };
  daily: ListHealthDailyRow[];
};

export function computeListHealth(
  events: ConsentEventInput[],
  options: { window: HalfOpenUtcWindow; timeZone: string },
): Omit<ListHealthSummary, "discovered"> {
  const { window, timeZone } = options;
  const byProfile = new Map<string, ConsentEventInput[]>();
  for (const event of events) {
    // Profile-less events (Klaviyo anomaly) still count toward totals but
    // can never form a transition.
    const key = event.profileId ?? `anon:${event.occurredAt.toISOString()}`;
    const list = byProfile.get(key);
    if (list) list.push(event);
    else byProfile.set(key, [event]);
  }

  const daily = new Map<string, ListHealthDailyRow>();
  const totals = { subscribed: 0, unsubscribed: 0, wonBack: 0, quickChurn: 0, net: 0 };
  const bump = (day: string, field: "subscribed" | "unsubscribed" | "wonBack" | "quickChurn") => {
    const row =
      daily.get(day) ??
      { day, subscribed: 0, unsubscribed: 0, wonBack: 0, quickChurn: 0, net: 0 };
    row[field] += 1;
    daily.set(day, row);
    totals[field] += 1;
  };

  for (const sequence of byProfile.values()) {
    sequence.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    for (let index = 0; index < sequence.length; index += 1) {
      const event = sequence[index];
      const inWindow =
        event.occurredAt >= window.from && event.occurredAt < window.to;
      if (!inWindow) continue;
      const day = deriveDayInTimezone(event.occurredAt, timeZone);
      const previous = index > 0 ? sequence[index - 1] : null;
      if (event.metricKind === "subscribed_to_list") {
        bump(day, "subscribed");
        if (previous?.metricKind === "unsubscribed_from_list") {
          bump(day, "wonBack");
        }
      } else {
        bump(day, "unsubscribed");
        if (
          previous?.metricKind === "subscribed_to_list" &&
          event.occurredAt.getTime() - previous.occurredAt.getTime() <=
            QUICK_CHURN_WINDOW_MS
        ) {
          bump(day, "quickChurn");
        }
      }
    }
  }

  const rows = [...daily.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  for (const row of rows) row.net = row.subscribed - row.unsubscribed;
  totals.net = totals.subscribed - totals.unsubscribed;
  return { totals, daily: rows };
}

export async function loadListHealth(input: {
  scope: KlaviyoConnectionScope;
  window: HalfOpenUtcWindow;
  timeZone: string;
}): Promise<ListHealthSummary> {
  const metrics = await db
    .select({ id: klaviyoMetrics.id, canonicalKind: klaviyoMetrics.canonicalKind })
    .from(klaviyoMetrics)
    .where(
      and(
        eq(klaviyoMetrics.organizationId, input.scope.organizationId),
        eq(klaviyoMetrics.storeId, input.scope.storeId),
        eq(klaviyoMetrics.connectionId, input.scope.connectionId),
        inArray(klaviyoMetrics.canonicalKind, [
          "subscribed_to_list",
          "unsubscribed_from_list",
        ]),
      ),
    );
  if (metrics.length === 0) {
    return {
      discovered: false,
      totals: { subscribed: 0, unsubscribed: 0, wonBack: 0, quickChurn: 0, net: 0 },
      daily: [],
    };
  }
  const kindByMetricId = new Map(
    metrics.map((metric) => [metric.id, metric.canonicalKind]),
  );
  // Full retained history (90d ingestion bound), NOT window-filtered: the
  // won-back/quick-churn "previous event" may predate the window.
  const rows = await db
    .select({
      profileId: klaviyoEvents.profileId,
      metricId: klaviyoEvents.metricId,
      occurredAt: klaviyoEvents.occurredAt,
    })
    .from(klaviyoEvents)
    .where(
      and(
        eq(klaviyoEvents.organizationId, input.scope.organizationId),
        eq(klaviyoEvents.storeId, input.scope.storeId),
        eq(klaviyoEvents.connectionId, input.scope.connectionId),
        inArray(
          klaviyoEvents.metricId,
          metrics.map((metric) => metric.id),
        ),
      ),
    );
  const events: ConsentEventInput[] = rows.map((row) => ({
    profileId: row.profileId,
    metricKind: kindByMetricId.get(row.metricId) as ConsentEventInput["metricKind"],
    occurredAt: row.occurredAt,
  }));
  return {
    discovered: true,
    ...computeListHealth(events, {
      window: input.window,
      timeZone: input.timeZone,
    }),
  };
}
