import { router, orgProcedure } from "../init";
import { openApiQueryMeta } from "../openapi-meta";
import {
  snapshotCampaignsReadInputSchema, snapshotCampaignsReadOutputSchema,
  snapshotMetricsReadInputSchema, snapshotMetricsReadOutputSchema,
  snapshotEventsReadInputSchema, snapshotEventsReadOutputSchema,
  snapshotCampaignValuesReadInputSchema, snapshotCampaignValuesReadOutputSchema,
} from "@/lib/klaviyo/snapshot-contracts";
import { readSnapshot } from "@/lib/klaviyo/snapshot-reads";

const description = "Bounded Postgres page from the latest published exact-scope snapshot, or snapshotId history. Continuations remain pinned to that snapshot. Missing data returns not_available; GET never fetches Klaviyo or queues work. Inspect snapshot freshness, privacy adjustments and latestRefresh separately.";

export const klaviyoReadsRouter = router({
  campaigns: orgProcedure
    .meta(openApiQueryMeta("klaviyoReads", "campaigns", "Read stored Klaviyo campaigns and messages", description))
    .input(snapshotCampaignsReadInputSchema).output(snapshotCampaignsReadOutputSchema)
    .query(async ({ ctx, input }) => snapshotCampaignsReadOutputSchema.parse(await readSnapshot(ctx.organizationId, { ...input, dataset: "campaigns" }))),
  metrics: orgProcedure
    .meta(openApiQueryMeta("klaviyoReads", "metrics", "Read stored Klaviyo metric catalog", description))
    .input(snapshotMetricsReadInputSchema).output(snapshotMetricsReadOutputSchema)
    .query(async ({ ctx, input }) => snapshotMetricsReadOutputSchema.parse(await readSnapshot(ctx.organizationId, { ...input, dataset: "metrics" }))),
  events: orgProcedure
    .meta(openApiQueryMeta("klaviyoReads", "events", "Read stored selected-metric events", `${description} Requires an exact canonical metric set and half-open window; overlapping snapshots are not composed. Profile/external IDs are pseudonymous, not verified Shopify identities.`))
    .input(snapshotEventsReadInputSchema).output(snapshotEventsReadOutputSchema)
    .query(async ({ ctx, input }) => snapshotEventsReadOutputSchema.parse(await readSnapshot(ctx.organizationId, { ...input, dataset: "events" }))),
  campaignValues: orgProcedure
    .meta(openApiQueryMeta("klaviyoReads", "campaignValues", "Read stored Klaviyo campaign performance", `${description} Requires an exact conversion metric and window. Preserves all 17 nullable provider statistics; rates are fractions, never additive. Unverified provider completeness is not an account total or reconciled Shopify revenue.`))
    .input(snapshotCampaignValuesReadInputSchema).output(snapshotCampaignValuesReadOutputSchema)
    .query(async ({ ctx, input }) => snapshotCampaignValuesReadOutputSchema.parse(await readSnapshot(ctx.organizationId, { ...input, dataset: "campaign_values" }))),
});
