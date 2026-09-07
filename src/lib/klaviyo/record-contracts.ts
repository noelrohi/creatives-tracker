import { z } from "zod";

/**
 * The five reviewed Klaviyo record contracts (ecomconn E3 acceptance
 * oracle): campaign, campaign message, metric, event and campaign value
 * row. Pure shared field definitions — imported by the provider adapters,
 * the snapshot store/reads and tests so the worker and the DB reader
 * validate the exact same shapes. This module must stay free of transport,
 * credential and database imports.
 */
const text = z.string().max(16384);
const id = z.string().min(1).max(256);
const instant = z.string().datetime({ offset: true });
const identifier = z.string().min(1).max(256);
const wallTime = z.string().max(64);
// Match ecomconn core/src/delivery/connector.ts requiredNumber and Klaviyo
// jobs.ts optionalNumber: finite numbers unchanged, null/undefined -> null.
const measure = z.number().finite().nullable();

export const klaviyoCampaignRecordSchema = z
  .object({
    campaignId: id,
    name: text.min(1),
    status: text.min(1),
    archived: z.boolean(),
    createdAt: instant,
    updatedAt: instant,
    scheduledAt: instant.nullable(),
    sendTime: instant.nullable(),
  })
  .strict();

export const klaviyoCampaignMessageRecordSchema = z
  .object({
    messageId: id,
    campaignId: id,
    channel: text.min(1),
    subject: text.nullable(),
    previewText: text.nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .strict();

export const klaviyoMetricRecordSchema = z
  .object({ metricId: id, name: text.nullable() })
  .strict();

export const klaviyoEventRecordSchema = z
  .object({
    eventId: id,
    metricId: id,
    metricName: text.nullable(),
    datetime: instant,
    profileId: id.nullable(),
    profileExternalId: text.nullable(),
    value: z.number().finite().nullable(),
    uuid: text.nullable(),
    orderId: text.nullable(),
    currency: text.nullable(),
  })
  .strict();

export const klaviyoCampaignValueRecordSchema = z
  .object({
    campaignId: identifier,
    campaignMessageId: identifier,
    sendChannel: identifier,
    conversionMetricId: identifier,
    timeframeStart: wallTime,
    timeframeEnd: wallTime,
    recipients: measure,
    delivered: measure,
    deliveryRate: measure,
    opensUnique: measure,
    openRate: measure,
    clicksUnique: measure,
    clickRate: measure,
    conversions: measure,
    conversionRate: measure,
    conversionValue: measure,
    revenuePerRecipient: measure,
    bounced: measure,
    bounceRate: measure,
    unsubscribes: measure,
    unsubscribeRate: measure,
    spamComplaints: measure,
    spamComplaintRate: measure,
  })
  .strict();

export type KlaviyoCampaignRecord = z.infer<typeof klaviyoCampaignRecordSchema>;
export type KlaviyoCampaignMessageRecord = z.infer<
  typeof klaviyoCampaignMessageRecordSchema
>;
export type KlaviyoMetricRecord = z.infer<typeof klaviyoMetricRecordSchema>;
export type KlaviyoEventRecord = z.infer<typeof klaviyoEventRecordSchema>;
export type KlaviyoCampaignValueRecord = z.infer<
  typeof klaviyoCampaignValueRecordSchema
>;
