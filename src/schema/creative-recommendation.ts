import { relations } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { ads } from "./ad";
import { adCreatives } from "./ad-creative";

export const creativeVariantStatusEnum = pgEnum("creative_variant_status", [
  "pending",
  "good",
  "bad",
]);

export type CreativeVariantCopy = {
  variantName: string;
  primaryText: string;
  headline: string;
  hook: string;
  cta: string;
  visualDirection: string;
  changeSummary: string;
  rationale: string;
  riskNotes?: string | null;
};

export type CreativeVariantSourceSnapshot = {
  creativeName: string;
  adName: string | null;
  caption: string | null;
  format: string | null;
  angle: string | null;
  persona: string | null;
  awarenessLevel: string | null;
  hook: string | null;
  tone: string[] | null;
  cta: string | null;
  assetUrl: string | null;
  videoUrl: string | null;
};

export type CreativeVariantPerformanceSnapshot = {
  from: string;
  to: string;
  spend: number;
  roas: number;
  conversions: number;
  revenue: number;
  cpa: number | null;
  ctr: number | null;
};

export const creativeVariantBatches = pgTable(
  "creative_variant_batch",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    sourceCreativeId: text("source_creative_id")
      .notNull()
      .references(() => adCreatives.id, { onDelete: "cascade" }),
    sourceAdId: text("source_ad_id").references(() => ads.id, {
      onDelete: "set null",
    }),
    windowFrom: text("window_from").notNull(),
    windowTo: text("window_to").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    sourceSnapshot: jsonb("source_snapshot")
      .$type<CreativeVariantSourceSnapshot>()
      .notNull(),
    performanceSnapshot: jsonb("performance_snapshot")
      .$type<CreativeVariantPerformanceSnapshot>()
      .notNull(),
    generatedCount: integer("generated_count").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("creative_variant_batch_org_idx").on(table.organizationId),
    index("creative_variant_batch_source_creative_idx").on(table.sourceCreativeId),
    index("creative_variant_batch_source_ad_idx").on(table.sourceAdId),
    index("creative_variant_batch_created_at_idx").on(table.createdAt),
  ],
);

export const creativeVariants = pgTable(
  "creative_variant",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    batchId: text("batch_id")
      .notNull()
      .references(() => creativeVariantBatches.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    position: integer("position").notNull(),
    status: creativeVariantStatusEnum("status").notNull().default("pending"),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at"),
    copy: jsonb("copy").$type<CreativeVariantCopy>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("creative_variant_batch_idx").on(table.batchId),
    index("creative_variant_org_idx").on(table.organizationId),
    index("creative_variant_status_idx").on(table.status),
  ],
);

export const creativeVariantBatchRelations = relations(
  creativeVariantBatches,
  ({ many, one }) => ({
    sourceCreative: one(adCreatives, {
      fields: [creativeVariantBatches.sourceCreativeId],
      references: [adCreatives.id],
    }),
    sourceAd: one(ads, {
      fields: [creativeVariantBatches.sourceAdId],
      references: [ads.id],
    }),
    variants: many(creativeVariants),
  }),
);

export const creativeVariantRelations = relations(creativeVariants, ({ one }) => ({
  batch: one(creativeVariantBatches, {
    fields: [creativeVariants.batchId],
    references: [creativeVariantBatches.id],
  }),
}));
