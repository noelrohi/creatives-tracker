import { router, orgProcedure } from "../init";
import { openApiQueryMeta } from "../openapi-meta";
import {
  campaignsInputSchema,
  campaignsOutputSchema,
  metricsInputSchema,
  metricsOutputSchema,
  eventsInputSchema,
  eventsOutputSchema,
  readCampaigns,
  readMetrics,
  readEvents,
} from "@/lib/klaviyo/collection-reads";
import {
  campaignValuesInputSchema,
  campaignValuesOutputSchema,
  readCampaignValues,
} from "@/lib/klaviyo/campaign-value-reads";
import { withKlaviyoReadContext } from "@/lib/klaviyo/read-service";
import { KlaviyoReadError } from "@/lib/klaviyo/read-transport";

/** Live, minimized provider reads. The evidence/admin router remains session-only. */
export const klaviyoReadsRouter = router({
  campaigns: orgProcedure
    .meta(openApiQueryMeta(
      "klaviyoReads", "campaigns", "Read Klaviyo campaigns and messages",
      "Live bounded page of campaigns and reviewed message fields. Follow nextContinuation with unchanged inputs through email, SMS and mobile-push, archived and unarchived campaigns. Not a historical snapshot or Shopify attribution report.",
    ))
    .input(campaignsInputSchema)
    .output(campaignsOutputSchema)
    .query(({ ctx, input }) => withKlaviyoReadContext(ctx.organizationId,
      ({ client, scope }) => readCampaigns(client, scope, input))),

  metrics: orgProcedure
    .meta(openApiQueryMeta(
      "klaviyoReads", "metrics", "Read the Klaviyo metric catalog",
      "Live account-wide metric IDs and names for the organization's configured Klaviyo connection. Follow nextContinuation until null. Metric names do not establish verified Shopify integration or attribution semantics.",
    ))
    .input(metricsInputSchema)
    .output(metricsOutputSchema)
    .query(({ ctx, input }) => withKlaviyoReadContext(ctx.organizationId,
      ({ client, scope }) => readMetrics(client, scope, input))),

  events: orgProcedure
    .meta(openApiQueryMeta(
      "klaviyoReads", "events", "Read selected Klaviyo metric events",
      "Live minimized events for 1–20 ordered metricIds and a half-open since/until window within the past 365 days. Each metric cursor chain completes before the next; ordering is not global across metrics. Keep metricIds and window unchanged on continuation. Profile IDs/external IDs are pseudonymous; orderId is the provider's event identifier, not a verified order match. Does not ingest or modify attribution evidence.",
    ))
    .input(eventsInputSchema)
    .output(eventsOutputSchema)
    .query(({ ctx, input }) => withKlaviyoReadContext(ctx.organizationId,
      ({ client, scope }) => readEvents(client, scope, input))),

  campaignValues: orgProcedure
    .meta(openApiQueryMeta(
      "klaviyoReads", "campaignValues", "Read Klaviyo campaign performance",
      "Live campaign/message/channel values with 17 provider statistics and an explicit conversionMetricId. Returns requested and account-local provider windows separately. Provider rounding and completeness limitations are explicit; unverified completeness is not a complete account total. Rates are provider fractions, not additive measures; conversion value is not reconciled Shopify revenue. Reporting has a low provider quota; honor retry guidance.",
    ))
    .input(campaignValuesInputSchema)
    .output(campaignValuesOutputSchema)
    .query(({ ctx, input }) => withKlaviyoReadContext(ctx.organizationId,
      ({ client, scope }) => {
        if (!scope.accountTimezone) throw new KlaviyoReadError("unavailable");
        return readCampaignValues(client, { ...scope, accountTimezone: scope.accountTimezone }, input);
      })),
});
