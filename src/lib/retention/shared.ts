/**
 * Category definitions shared by planRetention and executeRetention so the
 * dry-run report and the delete loop can never drift apart.
 *
 * Scope is the evidence graph only
 * (docs/superpowers/specs/2026-08-12-storage-retention-design.md §4).
 * Never listed here, deliberately: shopify_order, shopify_refund,
 * identity_matching_key_binding, identity_erasure_suppression,
 * identity_crypto_policy, uninstall receipts/retired keys,
 * klaviyo_report_fact, and all connection/metric/alias/join-rule/
 * marketing-object configuration.
 */

import { sql, type SQL } from "drizzle-orm";
import {
  baseWindowStart,
  breakdownWindowStart,
  evidenceWindowStart,
} from "./policy";

export type RetentionCutoffs = {
  base: string;
  breakdown: string;
  evidence: string;
};

export function retentionCutoffs(todayYmd: string): RetentionCutoffs {
  return {
    base: baseWindowStart(todayYmd),
    breakdown: breakdownWindowStart(todayYmd),
    evidence: evidenceWindowStart(todayYmd),
  };
}

export type RetentionCategoryDefinition = {
  key: string;
  table: string;
  alias: string;
  /** Org-scoped and cutoff-applied; every row it matches is deletable. */
  predicate: SQL;
  /** Business date the candidate window is measured on. */
  dateExpression: SQL;
  /** Children before parents; see design §4. */
  deleteOrder: number;
};

const BREAKDOWN_COLUMNS = [
  "country",
  "platform",
  "placement",
  "device",
  "age",
  "gender",
] as const;

// Same empty-or-null contract as basePerformanceLogFilter, minus its
// date_start = date_end clause: legacy multi-day rows are base rows here and
// expire on the 180-day window like any other.
function allDimensionsEmpty(alias: string): SQL {
  return sql.join(
    BREAKDOWN_COLUMNS.map(
      (column) => sql`coalesce(${sql.raw(`${alias}.${column}`)}, '') = ''`,
    ),
    sql` AND `,
  );
}

export function retentionCategoryDefinitions(
  organizationId: string,
  cutoffs: RetentionCutoffs,
): RetentionCategoryDefinition[] {
  return [
    {
      key: "performance_breakdown",
      table: "performance_log",
      alias: "pl",
      deleteOrder: 10,
      dateExpression: sql`pl.date_end`,
      predicate: sql`pl.organization_id = ${organizationId}
        AND NOT (${allDimensionsEmpty("pl")})
        AND pl.date_end < ${cutoffs.breakdown}::date`,
    },
    {
      key: "performance_base",
      table: "performance_log",
      alias: "pl",
      deleteOrder: 11,
      dateExpression: sql`pl.date_end`,
      predicate: sql`pl.organization_id = ${organizationId}
        AND ${allDimensionsEmpty("pl")}
        AND pl.date_end < ${cutoffs.base}::date`,
    },
    // Klaviyo event lineage; event products, run observations, identity
    // observations, event-side HMACs, the match graph and attribution claims
    // all cascade from klaviyo_event, so they are not separate categories.
    {
      key: "klaviyo_event",
      table: "klaviyo_event",
      alias: "ke",
      deleteOrder: 3,
      dateExpression: sql`ke.occurred_at`,
      predicate: sql`ke.organization_id = ${organizationId}
        AND ke.occurred_at < ${cutoffs.evidence}::timestamp`,
    },
    {
      key: "shopify_order_line",
      table: "shopify_order_line",
      alias: "sol",
      deleteOrder: 4,
      dateExpression: sql`sol.created_at`,
      predicate: sql`sol.organization_id = ${organizationId}
        AND sol.created_at < ${cutoffs.evidence}::timestamp`,
    },
    {
      key: "source_identity_hmac",
      table: "source_identity_hmac",
      alias: "sih",
      deleteOrder: 5,
      dateExpression: sql`sih.created_at`,
      predicate: sql`sih.organization_id = ${organizationId}
        AND sih.created_at < ${cutoffs.evidence}::timestamp`,
    },
    {
      key: "shopify_evidence_run_identity_observation",
      table: "shopify_evidence_run_identity_observation",
      alias: "serio",
      deleteOrder: 1,
      dateExpression: sql`serio.observed_at`,
      predicate: sql`serio.organization_id = ${organizationId}
        AND serio.observed_at < ${cutoffs.evidence}::timestamp`,
    },
    {
      key: "shopify_evidence_run_observation",
      table: "shopify_evidence_run_observation",
      alias: "sero",
      deleteOrder: 2,
      dateExpression: sql`sero.observed_at`,
      predicate: sql`sero.organization_id = ${organizationId}
        AND sero.observed_at < ${cutoffs.evidence}::timestamp`,
    },
    // Sync runs only once they are terminal, their requested window has
    // expired, and no observation still points at them.
    {
      key: "klaviyo_sync_run",
      table: "klaviyo_sync_run",
      alias: "ksr",
      deleteOrder: 6,
      dateExpression: sql`ksr.requested_to`,
      predicate: sql`ksr.organization_id = ${organizationId}
        AND ksr.status IN ('success', 'partial', 'failed')
        AND ksr.requested_to < ${cutoffs.evidence}::timestamp
        AND NOT EXISTS (
          SELECT 1 FROM klaviyo_event_run_observation kero
          WHERE kero.connection_id = ksr.connection_id
            AND kero.sync_run_id = ksr.id
        )`,
    },
    {
      key: "shopify_evidence_sync_run",
      table: "shopify_evidence_sync_run",
      alias: "sesr",
      deleteOrder: 7,
      dateExpression: sql`sesr.requested_to`,
      predicate: sql`sesr.organization_id = ${organizationId}
        AND sesr.status IN ('success', 'partial', 'failed')
        AND sesr.requested_to < ${cutoffs.evidence}::timestamp
        AND NOT EXISTS (
          SELECT 1 FROM shopify_evidence_run_observation sero
          WHERE sero.organization_id = sesr.organization_id
            AND sero.store_id = sesr.store_id
            AND sero.evidence_run_id = sesr.id
        )`,
    },
  ];
}
