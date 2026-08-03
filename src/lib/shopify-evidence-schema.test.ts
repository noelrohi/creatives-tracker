import { describe, expect, it } from "vitest";
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  normalizeRelation,
} from "drizzle-orm/relations";
import * as shopifyEvidenceSchema from "@/schema/shopify-evidence";
import * as shopifySchema from "@/schema/shopify";

describe("Shopify evidence relation graph", () => {
  it("normalizes the direct sync-run identity-observations relation", () => {
    const { tables, tableNamesMap } = extractTablesRelationalConfig(
      { ...shopifySchema, ...shopifyEvidenceSchema },
      createTableRelationsHelpers,
    );
    const relation =
      tables.shopifyEvidenceSyncRuns?.relations.identityObservations;

    expect(relation).toBeDefined();
    const normalized = normalizeRelation(tables, tableNamesMap, relation!);
    expect(normalized.fields.map((field) => field.name)).toEqual([
      "organization_id",
      "store_id",
      "id",
    ]);
    expect(normalized.references.map((reference) => reference.name)).toEqual([
      "organization_id",
      "store_id",
      "evidence_run_id",
    ]);
  });
});
