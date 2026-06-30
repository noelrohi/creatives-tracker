import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { basePerformanceLogFilter } from "@/lib/performance-log-sql";
import { effectiveAdStatusSql } from "@/lib/effective-ad-status";
import type {
  CreativeVariantCopy,
  CreativeVariantPerformanceSnapshot,
  CreativeVariantSourceSnapshot,
} from "@/schema/creative-recommendation";
import { winnerCandidateSqlPolicy } from "@/lib/creative-recommendation-policy";

const dbNumericSchema = z.union([z.string(), z.number()]).nullable();
const nullableStringSchema = z.string().nullable();

const candidateRowSchema = z.object({
  creative_id: z.string(),
  creative_name: z.string(),
  asset_url: nullableStringSchema,
  video_url: nullableStringSchema,
  format: nullableStringSchema,
  angle: nullableStringSchema,
  persona: nullableStringSchema,
  awareness_level: nullableStringSchema,
  hook: nullableStringSchema,
  tone: z.array(z.string()).nullable(),
  cta: nullableStringSchema,
  source_ad_id: z.string(),
  source_ad_name: z.string(),
  caption: nullableStringSchema,
  destination_url: nullableStringSchema,
  status: nullableStringSchema,
  spend: dbNumericSchema,
  revenue: dbNumericSchema,
  conversions: dbNumericSchema,
  impressions: dbNumericSchema,
  roas: dbNumericSchema,
  cpa: dbNumericSchema,
  ctr: dbNumericSchema,
  video_views_3s: dbNumericSchema,
  video_thruplay: dbNumericSchema,
});

const latestBatchRowSchema = z.object({
  id: z.string(),
  source_creative_id: z.string(),
  source_ad_id: z.string(),
  generated_count: z.coerce.number(),
  created_at: z.coerce.date(),
  pending_count: z.coerce.number(),
  good_count: z.coerce.number(),
  bad_count: z.coerce.number(),
});

const variantStatusSchema = z.enum(["pending", "good", "bad"]);
const creativeVariantCopyValueSchema = z.object({
  variantName: z.string(),
  primaryText: z.string(),
  headline: z.string(),
  hook: z.string(),
  cta: z.string(),
  visualDirection: z.string(),
  changeSummary: z.string(),
  rationale: z.string(),
  riskNotes: z.string().nullable().optional(),
}) satisfies z.ZodType<CreativeVariantCopy>;

const variantRowSchema = z.object({
  id: z.string(),
  batch_id: z.string(),
  position: z.coerce.number(),
  status: variantStatusSchema,
  copy: creativeVariantCopyValueSchema,
});

const approvedVariantRowSchema = z.object({
  batch_id: z.string(),
  source_creative_id: z.string(),
  source_name: z.string().nullable(),
  window_from: z.string(),
  window_to: z.string(),
  variant_id: z.string(),
  position: z.coerce.number(),
  status: variantStatusSchema,
  copy: creativeVariantCopyValueSchema,
});

type CandidateRow = z.infer<typeof candidateRowSchema>;
type VariantRow = z.infer<typeof variantRowSchema>;

export type CreativeRecommendationVariantView = {
  id: string;
  batchId: string;
  position: number;
  status: "pending" | "good" | "bad";
  copy: CreativeVariantCopy;
};

export type CreativeRecommendationLatestBatchView = {
  id: string;
  sourceAdId: string;
  generatedCount: number;
  createdAt: Date;
  pendingCount: number;
  goodCount: number;
  badCount: number;
  variants: CreativeRecommendationVariantView[];
};

export type CreativeRecommendationCandidateView = {
  sourceCreativeId: string;
  sourceCreativeName: string;
  sourceAdId: string;
  sourceAdName: string;
  caption: string | null;
  destinationUrl: string | null;
  assetUrl: string | null;
  videoUrl: string | null;
  format: string | null;
  angle: string | null;
  persona: string | null;
  awarenessLevel: string | null;
  hook: string | null;
  tone: string[] | null;
  cta: string | null;
  status: string | null;
  spend: number;
  revenue: number;
  conversions: number;
  roas: number;
  cpa: number | null;
  ctr: number | null;
  impressions: number;
  videoViews3s: number;
  videoThruplay: number;
  latestBatch: CreativeRecommendationLatestBatchView | null;
  sourceSnapshot: CreativeVariantSourceSnapshot;
  performanceSnapshot: CreativeVariantPerformanceSnapshot;
};

export type ApprovedCreativeVariantView = {
  batchId: string;
  sourceCreativeId: string;
  sourceName: string;
  windowFrom: string;
  windowTo: string;
  variant: CreativeRecommendationVariantView;
};

type WinnerCandidateLookupInput = {
  organizationId: string;
  from: string;
  to: string;
  accountId?: string;
  teamId?: string;
  sourceCreativeId?: string;
  sourceAdId?: string;
};

function parseRows<T>(schema: z.ZodType<T>, rows: unknown[]): T[] {
  return z.array(schema).parse(rows);
}

function parseNullableNumber(value: string | number | null): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRequiredNumber(
  value: string | number | null,
  label: string,
  row: Pick<CandidateRow, "creative_id" | "source_ad_id">,
) {
  const parsed = parseNullableNumber(value);
  if (parsed == null) {
    throw new Error(
      `Eligible recommendation candidate ${row.creative_id}/${row.source_ad_id} is missing required metric ${label}.`,
    );
  }
  return parsed;
}

function accountFilter(accountId?: string) {
  return accountId ? sql`AND ad.account_id = ${accountId}` : sql``;
}

function teamFilter(teamId?: string) {
  if (!teamId) return sql``;
  if (teamId === "none") return sql`AND ac.team_id IS NULL`;
  return sql`AND ac.team_id = ${teamId}`;
}

function batchKey(sourceCreativeId: string, sourceAdId: string) {
  return `${sourceCreativeId}:${sourceAdId}`;
}

function mapVariant(row: VariantRow): CreativeRecommendationVariantView {
  return {
    id: row.id,
    batchId: row.batch_id,
    position: row.position,
    status: row.status,
    copy: row.copy,
  };
}

function mapCandidate(
  row: CandidateRow,
  window: { from: string; to: string },
  latestBatch?: CreativeRecommendationLatestBatchView,
): CreativeRecommendationCandidateView {
  const sourceSnapshot: CreativeVariantSourceSnapshot = {
    creativeName: row.creative_name,
    adName: row.source_ad_name,
    caption: row.caption,
    format: row.format,
    angle: row.angle,
    persona: row.persona,
    awarenessLevel: row.awareness_level,
    hook: row.hook,
    tone: row.tone,
    cta: row.cta,
    assetUrl: row.asset_url,
    videoUrl: row.video_url,
  };
  const performanceSnapshot: CreativeVariantPerformanceSnapshot = {
    from: window.from,
    to: window.to,
    spend: parseRequiredNumber(row.spend, "spend", row),
    revenue: parseRequiredNumber(row.revenue, "revenue", row),
    conversions: parseRequiredNumber(row.conversions, "conversions", row),
    roas: parseRequiredNumber(row.roas, "roas", row),
    cpa: parseNullableNumber(row.cpa),
    ctr: parseNullableNumber(row.ctr),
  };
  const impressions = parseNullableNumber(row.impressions) ?? 0;
  const videoViews3s = parseNullableNumber(row.video_views_3s) ?? 0;
  const videoThruplay = parseNullableNumber(row.video_thruplay) ?? 0;

  return {
    sourceCreativeId: row.creative_id,
    sourceCreativeName: row.creative_name,
    sourceAdId: row.source_ad_id,
    sourceAdName: row.source_ad_name,
    caption: row.caption,
    destinationUrl: row.destination_url,
    assetUrl: row.asset_url,
    videoUrl: row.video_url,
    format: row.format,
    angle: row.angle,
    persona: row.persona,
    awarenessLevel: row.awareness_level,
    hook: row.hook,
    tone: row.tone,
    cta: row.cta,
    status: row.status,
    spend: performanceSnapshot.spend,
    revenue: performanceSnapshot.revenue,
    conversions: performanceSnapshot.conversions,
    roas: performanceSnapshot.roas,
    cpa: performanceSnapshot.cpa,
    ctr: performanceSnapshot.ctr,
    impressions,
    videoViews3s,
    videoThruplay,
    latestBatch: latestBatch ?? null,
    sourceSnapshot,
    performanceSnapshot,
  };
}

async function fetchCandidateRows(input: WinnerCandidateLookupInput) {
  const basePl = basePerformanceLogFilter("pl");
  const sourceCreativeFilter = input.sourceCreativeId
    ? sql`AND ac.id = ${input.sourceCreativeId}`
    : sql``;
  const sourceAdFilter = input.sourceAdId
    ? sql`AND ad.id = ${input.sourceAdId}`
    : sql``;

  const spendExpression = sql`coalesce(sum(pl.spend), 0)`;
  const revenueExpression = sql`coalesce(sum(pl.purchase_value), 0)`;
  const conversionsExpression = sql`coalesce(sum(pl.conversions), 0)`;
  const impressionsExpression = sql`coalesce(sum(pl.impressions), 0)`;
  const roasExpression = sql`(${revenueExpression} / nullif(${spendExpression}, 0))`;
  const cpaExpression = sql`(${spendExpression} / nullif(${conversionsExpression}, 0))`;
  const ctrExpression = sql`(coalesce(sum(pl.ctr * pl.impressions), 0) / nullif(sum(pl.impressions), 0))`;
  const videoViews3sExpression = sql`coalesce(sum(pl.video_views_3s), 0)`;
  const videoThruplayExpression = sql`coalesce(sum(pl.video_thruplay), 0)`;
  const statusExpression = effectiveAdStatusSql(sql`ad.status`, sql`ast.status`);

  const result = await db.execute(sql`
    WITH ad_window AS (
      SELECT
        ac.id AS creative_id,
        ac.name AS creative_name,
        ac.asset_url,
        ac.video_url,
        ac.format::text AS format,
        ac.angle,
        ac.persona,
        ac.awareness_level::text AS awareness_level,
        ac.hook,
        ac.tone,
        ac.cta,
        ad.id AS source_ad_id,
        ad.name AS source_ad_name,
        ad.caption,
        ad.destination_url,
        ${statusExpression} AS status,
        ${spendExpression}::text AS spend,
        ${revenueExpression}::text AS revenue,
        ${conversionsExpression}::text AS conversions,
        ${impressionsExpression}::text AS impressions,
        ${roasExpression}::text AS roas,
        ${cpaExpression}::text AS cpa,
        ${ctrExpression}::text AS ctr,
        ${videoViews3sExpression}::text AS video_views_3s,
        ${videoThruplayExpression}::text AS video_thruplay
      FROM ad
      JOIN ad_creative ac ON ac.id = ad.ad_creative_id
      LEFT JOIN ad_set ast ON ast.id = ad.ad_set_id
      JOIN performance_log pl ON pl.ad_id = ad.id
      WHERE ad.organization_id = ${input.organizationId}
        AND ${basePl}
        AND pl.date_start <= ${input.to}::date
        AND pl.date_end >= ${input.from}::date
        ${accountFilter(input.accountId)}
        ${teamFilter(input.teamId)}
        ${sourceCreativeFilter}
        ${sourceAdFilter}
      GROUP BY
        ac.id,
        ac.name,
        ac.asset_url,
        ac.video_url,
        ac.format,
        ac.angle,
        ac.persona,
        ac.awareness_level,
        ac.hook,
        ac.tone,
        ac.cta,
        ad.id,
        ad.name,
        ad.caption,
        ad.destination_url,
        ad.status,
        ast.status
      HAVING ${winnerCandidateSqlPolicy({
        format: sql`ac.format`,
        videoUrl: sql`ac.video_url`,
        impressions: impressionsExpression,
        videoViews3s: videoViews3sExpression,
        videoThruplay: videoThruplayExpression,
        status: statusExpression,
        spend: spendExpression,
        roas: roasExpression,
        conversions: conversionsExpression,
        sourceContext: {
          caption: sql`ad.caption`,
          hook: sql`ac.hook`,
          angle: sql`ac.angle`,
          persona: sql`ac.persona`,
          cta: sql`ac.cta`,
        },
      })}
    ),
    ranked AS (
      SELECT
        *,
        row_number() OVER (
          PARTITION BY creative_id
          ORDER BY conversions::numeric DESC NULLS LAST, roas::numeric DESC NULLS LAST, spend::numeric DESC NULLS LAST
        ) AS rn
      FROM ad_window
    )
    SELECT *
    FROM ranked
    WHERE rn = 1
    ORDER BY conversions::numeric DESC NULLS LAST, roas::numeric DESC NULLS LAST
    LIMIT 25
  `);

  return parseRows(candidateRowSchema, result.rows);
}

async function fetchVariantsByBatchId(organizationId: string, batchIds: string[]) {
  if (batchIds.length === 0) {
    return new Map<string, CreativeRecommendationVariantView[]>();
  }

  const result = await db.execute(sql`
    SELECT
      id,
      batch_id,
      position,
      status::text AS status,
      copy
    FROM creative_variant
    WHERE organization_id = ${organizationId}
      AND batch_id IN (${sql.join(batchIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY batch_id, position ASC
  `);
  const variants = parseRows(variantRowSchema, result.rows).map(mapVariant);

  const variantsByBatch = new Map<string, CreativeRecommendationVariantView[]>();
  for (const variant of variants) {
    const batchVariants = variantsByBatch.get(variant.batchId) ?? [];
    batchVariants.push(variant);
    variantsByBatch.set(variant.batchId, batchVariants);
  }
  return variantsByBatch;
}

async function fetchLatestCandidateBatches(
  organizationId: string,
  candidates: Array<Pick<CreativeRecommendationCandidateView, "sourceCreativeId" | "sourceAdId">>,
  window: { from: string; to: string },
) {
  if (candidates.length === 0) {
    return new Map<string, CreativeRecommendationLatestBatchView>();
  }

  const candidatePairs = sql.join(
    candidates.map((candidate) => sql`(${candidate.sourceCreativeId}, ${candidate.sourceAdId})`),
    sql`, `,
  );

  const result = await db.execute(sql`
    WITH candidate_pairs(source_creative_id, source_ad_id) AS (
      VALUES ${candidatePairs}
    ),
    latest AS (
      SELECT DISTINCT ON (b.source_creative_id, b.source_ad_id)
        b.id,
        b.source_creative_id,
        b.source_ad_id,
        b.generated_count,
        b.created_at
      FROM creative_variant_batch b
      JOIN candidate_pairs p
        ON p.source_creative_id = b.source_creative_id
        AND p.source_ad_id = b.source_ad_id
      WHERE b.organization_id = ${organizationId}
        AND b.window_from = ${window.from}
        AND b.window_to = ${window.to}
      ORDER BY b.source_creative_id, b.source_ad_id, b.created_at DESC
    )
    SELECT
      latest.id,
      latest.source_creative_id,
      latest.source_ad_id,
      latest.generated_count,
      latest.created_at,
      count(*) FILTER (WHERE v.status = 'pending')::int AS pending_count,
      count(*) FILTER (WHERE v.status = 'good')::int AS good_count,
      count(*) FILTER (WHERE v.status = 'bad')::int AS bad_count
    FROM latest
    LEFT JOIN creative_variant v ON v.batch_id = latest.id
    GROUP BY latest.id, latest.source_creative_id, latest.source_ad_id, latest.generated_count, latest.created_at
  `);

  const rows = parseRows(latestBatchRowSchema, result.rows);
  const variantsByBatch = await fetchVariantsByBatchId(
    organizationId,
    rows.map((row) => row.id),
  );

  return new Map(
    rows.map((row) => [
      batchKey(row.source_creative_id, row.source_ad_id),
      {
        id: row.id,
        sourceAdId: row.source_ad_id,
        generatedCount: row.generated_count,
        createdAt: row.created_at,
        pendingCount: row.pending_count,
        goodCount: row.good_count,
        badCount: row.bad_count,
        variants: variantsByBatch.get(row.id) ?? [],
      },
    ]),
  );
}

export async function findEligibleWinnerCandidates(
  input: WinnerCandidateLookupInput,
): Promise<CreativeRecommendationCandidateView[]> {
  const rows = await fetchCandidateRows(input);
  const candidates = rows
    .map((row) => mapCandidate(row, { from: input.from, to: input.to }));
  const latestBatches = await fetchLatestCandidateBatches(
    input.organizationId,
    candidates,
    { from: input.from, to: input.to },
  );

  return candidates.map((candidate) => ({
    ...candidate,
    latestBatch: latestBatches.get(batchKey(candidate.sourceCreativeId, candidate.sourceAdId)) ?? null,
  }));
}

export async function listApprovedCreativeVariants(
  organizationId: string,
): Promise<ApprovedCreativeVariantView[]> {
  const result = await db.execute(sql`
    SELECT
      b.id AS batch_id,
      b.source_creative_id,
      b.source_snapshot ->> 'creativeName' AS source_name,
      b.window_from,
      b.window_to,
      v.id AS variant_id,
      v.position,
      v.status::text AS status,
      v.copy
    FROM creative_variant v
    JOIN creative_variant_batch b ON b.id = v.batch_id
    WHERE v.organization_id = ${organizationId}
      AND b.organization_id = ${organizationId}
      AND v.status = 'good'
    ORDER BY coalesce(v.reviewed_at, v.updated_at) DESC, b.created_at DESC, v.position ASC
  `);

  return parseRows(approvedVariantRowSchema, result.rows).map((row) => ({
    batchId: row.batch_id,
    sourceCreativeId: row.source_creative_id,
    sourceName: row.source_name?.trim() || "Untitled creative",
    windowFrom: row.window_from,
    windowTo: row.window_to,
    variant: {
      id: row.variant_id,
      batchId: row.batch_id,
      position: row.position,
      status: row.status,
      copy: row.copy,
    },
  }));
}
