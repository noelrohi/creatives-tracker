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
  /**
   * Counted in the plan so approvers see the full blast radius, but never
   * deleted directly — PostgreSQL removes these rows with their parent
   * (ON DELETE CASCADE from klaviyo_event).
   */
  cascadeOnly?: boolean;
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

function cascadeFromDoomedEvents(
  organizationId: string,
  cutoffs: RetentionCutoffs,
  tables: { table: string; alias: string; eventColumns: string[] }[],
): RetentionCategoryDefinition[] {
  return tables.map(({ table, alias, eventColumns }) => ({
    key: table,
    table,
    alias,
    deleteOrder: 0,
    cascadeOnly: true,
    dateExpression: sql`NULL::date`,
    predicate: sql.join(
      [
        sql`${sql.raw(`${alias}.organization_id`)} = ${organizationId} AND (`,
        sql.join(
          eventColumns.map(
            (column) => sql`EXISTS (
              SELECT 1 FROM klaviyo_event ke
              WHERE ke.id = ${sql.raw(`${alias}.${column}`)}
                AND ke.organization_id = ${organizationId}
                AND ke.occurred_at < ${cutoffs.evidence}::timestamp
            )`,
          ),
          sql` OR `,
        ),
        sql`)`,
      ],
      sql` `,
    ),
  }));
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
        AND pl.date_start = pl.date_end
        AND pl.date_end < ${cutoffs.base}::date`,
    },
    // Legacy multi-day base rows are their own category so an approver sees
    // them: the monthly rollup deliberately never sums them (they duplicate
    // daily rows where both exist; the admin purge tool is the sanctioned
    // reconciler), so their spend leaves without entering a summary.
    {
      key: "performance_base_multi_day",
      table: "performance_log",
      alias: "pl",
      deleteOrder: 12,
      dateExpression: sql`pl.date_end`,
      predicate: sql`pl.organization_id = ${organizationId}
        AND ${allDimensionsEmpty("pl")}
        AND pl.date_start <> pl.date_end
        AND pl.date_end < ${cutoffs.base}::date`,
    },
    // Klaviyo event lineage; event products, run observations, identity
    // observations, event-side HMACs, the match graph and attribution claims
    // all cascade from klaviyo_event. The cascadeOnly categories below count
    // that blast radius for the plan; only klaviyo_event itself is deleted.
    {
      key: "klaviyo_event",
      table: "klaviyo_event",
      alias: "ke",
      deleteOrder: 3,
      dateExpression: sql`ke.occurred_at`,
      predicate: sql`ke.organization_id = ${organizationId}
        AND ke.occurred_at < ${cutoffs.evidence}::timestamp`,
    },
    ...cascadeFromDoomedEvents(organizationId, cutoffs, [
      // Claims can also cascade via a doomed interaction event; counting by
      // the (not-null) conversion event covers the practical population.
      { table: "klaviyo_attribution_claim", alias: "kac", eventColumns: ["conversion_event_id"] },
      { table: "klaviyo_match_candidate", alias: "kmc", eventColumns: ["event_id"] },
      { table: "klaviyo_event_match_result", alias: "kemr", eventColumns: ["event_id"] },
      { table: "klaviyo_order_match_result", alias: "komr", eventColumns: ["selected_event_id"] },
      {
        table: "klaviyo_product_evidence_link",
        alias: "kpel",
        eventColumns: ["ordered_product_event_id", "placed_order_event_id"],
      },
      { table: "klaviyo_event_product", alias: "kep", eventColumns: ["event_id"] },
      { table: "klaviyo_event_run_observation", alias: "kero", eventColumns: ["event_id"] },
    ]),
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
    // expired, and nothing retained still points at them: neither an event
    // observation nor a match run (match runs cascade from their sync runs,
    // and they are only supposed to fall via their events — design §4).
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
        )
        AND NOT EXISTS (
          SELECT 1 FROM klaviyo_match_run kmr
          WHERE kmr.connection_id = ksr.connection_id
            AND kmr.source_run_id = ksr.id
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
        )
        AND NOT EXISTS (
          SELECT 1 FROM klaviyo_match_run kmr
          WHERE kmr.organization_id = sesr.organization_id
            AND kmr.shopify_evidence_run_id = sesr.id
        )`,
    },
  ];
}
