import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";
import { router, orgProcedure } from "../init";
import { openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { basePerformanceLogFilter } from "@/lib/performance-log-sql";

const managerStatusSchema = z.enum(["active", "paused", "archived"]);

type ManagerStatus = z.infer<typeof managerStatusSchema>;

const managerRowSchema = z.object({
  id: z.string(),
  metaId: z.string().nullable(),
  name: z.string(),
  status: managerStatusSchema,
  spend: z.string(),
  roas: z.string().nullable(),
  cpa: z.string().nullable(),
  ctr: z.string().nullable(),
  conversions: z.number().int(),
  hasChildren: z.boolean(),
});

// Null when no search is active; the client only needs it to auto-expand the
// branches that are on the path to a search hit (§6).
const hasMatchesField = { hasMatches: z.boolean().nullable() };

const managerCampaignRowSchema = managerRowSchema.extend({
  accountName: z.string().nullable(),
  ...hasMatchesField,
});

const managerAdSetRowSchema = managerRowSchema.extend(hasMatchesField);

type AggregateRow = {
  id: string;
  meta_id: string | null;
  name: string;
  status: ManagerStatus;
  spend: string;
  roas: string | null;
  cpa: string | null;
  ctr: string | null;
  conversions: number;
  has_children: boolean;
};

type MatchAggregateRow = AggregateRow & {
  has_matches: boolean | null;
};

type CampaignAggregateRow = MatchAggregateRow & {
  account_name: string | null;
};

function mapRow(row: AggregateRow) {
  return {
    id: row.id,
    metaId: row.meta_id,
    name: row.name,
    status: row.status,
    spend: row.spend,
    roas: row.roas,
    cpa: row.cpa,
    ctr: row.ctr,
    conversions: row.conversions,
    hasChildren: row.has_children,
  };
}

function searchPattern(search: string | undefined): string | null {
  const trimmed = search?.trim();
  return trimmed ? `%${trimmed}%` : null;
}

function statusMatches(column: string, status: ManagerStatus | undefined): SQL {
  return status ? sql`${sql.raw(column)} = ${status}` : sql`TRUE`;
}

function nameMatches(column: string, pattern: string): SQL {
  return sql`${sql.raw(column)} ILIKE ${pattern}`;
}

// Metric sums, gathered once per grouping key from the level's base rows.
const perfSums = sql`
  sum(pl.spend) AS spend_sum,
  sum(pl.purchase_value) AS purchase_value_sum,
  sum(pl.conversions) AS conversions_sum,
  sum(pl.ctr * pl.impressions) AS ctr_impressions_sum,
  sum(pl.impressions) AS impressions_sum
`;

// Every ratio is a ratio of sums, never an average of per-day ratios, and CTR
// is impression-weighted (spec §4).
const metricProjection = sql`
  coalesce(perf.spend_sum, 0)::text AS spend,
  (perf.purchase_value_sum / nullif(perf.spend_sum, 0))::text AS roas,
  (perf.spend_sum / nullif(perf.conversions_sum, 0))::text AS cpa,
  (perf.ctr_impressions_sum / nullif(perf.impressions_sum, 0))::text AS ctr,
  coalesce(perf.conversions_sum, 0)::int AS conversions
`;

// Base rows only, org-scoped, inside the range — the column order matches
// performance_log_org_ad_date_idx. LEFT JOIN so an entity without activity in
// the range still comes back with zeroed metrics instead of disappearing (§6).
function perfJoin(
  adId: SQL,
  organizationId: string,
  from: string,
  to: string,
): SQL {
  return sql`
    LEFT JOIN performance_log pl
      ON pl.ad_id = ${adId}
      AND pl.organization_id = ${organizationId}
      AND pl.date_start >= ${from}
      AND pl.date_start <= ${to}
      AND ${basePerformanceLogFilter("pl")}
  `;
}

const dateRangeInput = {
  from: z.string(),
  to: z.string(),
};

const filterInput = {
  status: managerStatusSchema.optional(),
  search: z.string().optional(),
};

export const managerRouter = router({
  campaigns: orgProcedure
    .meta(openApiQueryMeta("manager", "campaigns"))
    .input(
      z.object({
        ...dateRangeInput,
        accountId: z.string().optional(),
        ...filterInput,
      }),
    )
    .output(z.array(managerCampaignRowSchema))
    .query(async ({ input, ctx }) => {
      const org = ctx.organizationId;
      const pattern = searchPattern(input.search);
      const accountFilter = input.accountId
        ? sql`AND c.account_id = ${input.accountId}`
        : sql``;

      // `unprune` carries a search hit down the tree: an entity that matches
      // the search itself keeps its whole subtree in the counted set.
      const campaignUnprune = pattern ? nameMatches("c.name", pattern) : sql`FALSE`;
      const adSetUnprune = pattern
        ? sql`(s.unprune OR ${nameMatches("ast.name", pattern)})`
        : sql`FALSE`;
      const adSearchFilter = pattern
        ? sql`AND (sas.unprune OR ${nameMatches("a.name", pattern)})`
        : sql``;
      const campaignSearchKeep = pattern ? sql`s.unprune` : sql`TRUE`;
      const adSetSearchKeep = pattern ? sql`sas.unprune` : sql`TRUE`;
      const hasMatchesProjection = pattern
        ? sql`(
            s.unprune
            OR EXISTS (
              SELECT 1 FROM scoped_ad_sets sas
              WHERE sas.campaign_id = s.id
                AND ${nameMatches("sas.name", pattern)}
                AND ${statusMatches("sas.status", input.status)}
            )
            OR EXISTS (
              SELECT 1 FROM counted_ads ca
              WHERE ca.campaign_id = s.id AND ${nameMatches("ca.name", pattern)}
            )
          )`
        : sql`NULL::boolean`;

      const result = await db.execute(sql`
        WITH scoped AS (
          SELECT
            c.id,
            c.meta_id,
            c.name,
            c.status,
            acc.name AS account_name,
            ${campaignUnprune} AS unprune
          FROM campaign c
          LEFT JOIN ad_account acc ON acc.id = c.account_id
          WHERE c.organization_id = ${org} ${accountFilter}
        ),
        scoped_ad_sets AS (
          SELECT
            ast.id,
            ast.name,
            ast.status,
            s.id AS campaign_id,
            ${adSetUnprune} AS unprune
          FROM scoped s
          JOIN ad_set ast ON ast.campaign_id = s.id AND ast.organization_id = ${org}
        ),
        counted_ads AS (
          SELECT a.id, a.name, sas.id AS ad_set_id, sas.campaign_id
          FROM scoped_ad_sets sas
          JOIN ad a ON a.ad_set_id = sas.id AND a.organization_id = ${org}
          WHERE ${statusMatches("a.status", input.status)} ${adSearchFilter}
        ),
        kept_ad_sets AS (
          SELECT DISTINCT sas.campaign_id
          FROM scoped_ad_sets sas
          WHERE (${statusMatches("sas.status", input.status)} AND ${adSetSearchKeep})
            OR EXISTS (SELECT 1 FROM counted_ads ca WHERE ca.ad_set_id = sas.id)
        ),
        perf AS (
          SELECT ca.campaign_id AS id, ${perfSums}
          FROM counted_ads ca
          ${perfJoin(sql.raw("ca.id"), org, input.from, input.to)}
          GROUP BY ca.campaign_id
        )
        SELECT
          s.id,
          s.meta_id,
          s.name,
          s.status,
          s.account_name,
          ${metricProjection},
          (kas.campaign_id IS NOT NULL) AS has_children,
          ${hasMatchesProjection} AS has_matches
        FROM scoped s
        LEFT JOIN perf ON perf.id = s.id
        LEFT JOIN kept_ad_sets kas ON kas.campaign_id = s.id
        WHERE (${statusMatches("s.status", input.status)} AND ${campaignSearchKeep})
          OR kas.campaign_id IS NOT NULL
        ORDER BY coalesce(perf.spend_sum, 0) DESC, s.name ASC
      `);

      return (result.rows as CampaignAggregateRow[]).map((row) => ({
        ...mapRow(row),
        accountName: row.account_name,
        hasMatches: row.has_matches,
      }));
    }),

  adSets: orgProcedure
    .meta(openApiQueryMeta("manager", "adSets"))
    .input(
      z.object({
        campaignId: z.string(),
        ...dateRangeInput,
        ...filterInput,
      }),
    )
    .output(z.array(managerAdSetRowSchema))
    .query(async ({ input, ctx }) => {
      const org = ctx.organizationId;
      const pattern = searchPattern(input.search);

      const campaignUnprune = pattern ? nameMatches("c.name", pattern) : sql`FALSE`;
      const adSetUnprune = pattern
        ? sql`(par.unprune OR ${nameMatches("ast.name", pattern)})`
        : sql`FALSE`;
      const adSearchFilter = pattern
        ? sql`AND (s.unprune OR ${nameMatches("a.name", pattern)})`
        : sql``;
      const adSetSearchKeep = pattern ? sql`s.unprune` : sql`TRUE`;
      // Same semantics as the campaign level: on a match path either because
      // the ad set (or its campaign) matches — `unprune` — or because it holds
      // a matching ad that survived the status filter.
      const hasMatchesProjection = pattern
        ? sql`(
            s.unprune
            OR EXISTS (
              SELECT 1 FROM counted_ads ca
              WHERE ca.ad_set_id = s.id AND ${nameMatches("ca.name", pattern)}
            )
          )`
        : sql`NULL::boolean`;

      const result = await db.execute(sql`
        WITH parent AS (
          SELECT c.id, ${campaignUnprune} AS unprune
          FROM campaign c
          WHERE c.id = ${input.campaignId} AND c.organization_id = ${org}
        ),
        scoped AS (
          SELECT
            ast.id,
            ast.meta_id,
            ast.name,
            ast.status,
            ${adSetUnprune} AS unprune
          FROM parent par
          JOIN ad_set ast ON ast.campaign_id = par.id AND ast.organization_id = ${org}
        ),
        counted_ads AS (
          SELECT a.id, a.name, s.id AS ad_set_id
          FROM scoped s
          JOIN ad a ON a.ad_set_id = s.id AND a.organization_id = ${org}
          WHERE ${statusMatches("a.status", input.status)} ${adSearchFilter}
        ),
        perf AS (
          SELECT
            ca.ad_set_id AS id,
            count(DISTINCT ca.id)::int AS child_count,
            ${perfSums}
          FROM counted_ads ca
          ${perfJoin(sql.raw("ca.id"), org, input.from, input.to)}
          GROUP BY ca.ad_set_id
        )
        SELECT
          s.id,
          s.meta_id,
          s.name,
          s.status,
          ${metricProjection},
          (coalesce(perf.child_count, 0) > 0) AS has_children,
          ${hasMatchesProjection} AS has_matches
        FROM scoped s
        LEFT JOIN perf ON perf.id = s.id
        WHERE (${statusMatches("s.status", input.status)} AND ${adSetSearchKeep})
          OR perf.id IS NOT NULL
        ORDER BY coalesce(perf.spend_sum, 0) DESC, s.name ASC
      `);

      return (result.rows as MatchAggregateRow[]).map((row) => ({
        ...mapRow(row),
        hasMatches: row.has_matches,
      }));
    }),

  ads: orgProcedure
    .meta(openApiQueryMeta("manager", "ads"))
    .input(
      z.object({
        adSetId: z.string(),
        ...dateRangeInput,
        ...filterInput,
      }),
    )
    .output(z.array(managerRowSchema))
    .query(async ({ input, ctx }) => {
      const org = ctx.organizationId;
      const pattern = searchPattern(input.search);

      // A search hit on either ancestor keeps every ad in this ad set.
      const ancestorUnprune = pattern
        ? sql`(${nameMatches("ast.name", pattern)} OR ${nameMatches("c.name", pattern)})`
        : sql`FALSE`;
      const adSearchFilter = pattern
        ? sql`AND (par.unprune OR ${nameMatches("a.name", pattern)})`
        : sql``;

      const result = await db.execute(sql`
        WITH parent AS (
          SELECT ast.id, ${ancestorUnprune} AS unprune
          FROM ad_set ast
          JOIN campaign c ON c.id = ast.campaign_id
          WHERE ast.id = ${input.adSetId} AND ast.organization_id = ${org}
        ),
        scoped AS (
          SELECT a.id, a.meta_id, a.name, a.status
          FROM parent par
          JOIN ad a ON a.ad_set_id = par.id AND a.organization_id = ${org}
          WHERE ${statusMatches("a.status", input.status)} ${adSearchFilter}
        ),
        perf AS (
          SELECT s.id, ${perfSums}
          FROM scoped s
          ${perfJoin(sql.raw("s.id"), org, input.from, input.to)}
          GROUP BY s.id
        )
        SELECT
          s.id,
          s.meta_id,
          s.name,
          s.status,
          ${metricProjection},
          FALSE AS has_children
        FROM scoped s
        LEFT JOIN perf ON perf.id = s.id
        ORDER BY coalesce(perf.spend_sum, 0) DESC, s.name ASC
      `);

      return (result.rows as AggregateRow[]).map(mapRow);
    }),
});
