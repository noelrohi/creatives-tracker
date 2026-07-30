import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  buildPerformanceLogRows,
  matchExistingAdsForImport,
  resolveAdsForRows,
  toStagingPerfRow,
  type ExistingAdRow,
} from "@/lib/meta-import";

const mocks = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  whereConditions: [] as unknown[],
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(function (this: unknown) { return this; }),
      where: vi.fn((condition: unknown) => {
        mocks.whereConditions.push(condition);
        return Promise.resolve(mocks.selectResults.shift() ?? []);
      }),
    })),
  },
}));

const dialect = new PgDialect();

function renderedWhere(index: number) {
  return dialect.sqlToQuery(mocks.whereConditions[index] as SQL);
}

function existingAd(overrides: Partial<ExistingAdRow> & { id: string; name: string }): ExistingAdRow {
  return { adCreativeId: null, adSetId: null, metaId: null, ...overrides };
}

const baseRow = {
  dateStart: "2026-07-01",
  dateEnd: "2026-07-01",
  spend: "12.34",
};

describe("buildPerformanceLogRows", () => {
  it("never name-matches a row that carries a Meta ad id", () => {
    const perfRows = buildPerformanceLogRows({
      rows: [
        { ...baseRow, name: "Shared name", adId: "meta-known" },
        { ...baseRow, name: "Shared name", adId: "meta-unknown" },
      ],
      adIdByMetaId: new Map([["meta-known", "ad-known"]]),
      adIdByName: new Map([["Shared name", "ad-legacy"]]),
      organizationId: "org-1",
    });

    expect(perfRows).toHaveLength(1);
    expect(perfRows[0]).toMatchObject({ adId: "ad-known", metaAdId: "meta-known" });
  });

  it("stamps meta_ad_id onto rows all the way into the staging payload", () => {
    const [perfRow] = buildPerformanceLogRows({
      rows: [{ ...baseRow, name: "Ad A", adId: "meta-a" }],
      adIdByMetaId: new Map([["meta-a", "ad-a"]]),
      adIdByName: new Map(),
      organizationId: "org-1",
    });

    expect(perfRow?.metaAdId).toBe("meta-a");
    expect(toStagingPerfRow(perfRow!)).toMatchObject({ ad_id: "ad-a", meta_ad_id: "meta-a" });
  });

  it("leaves meta_ad_id null for id-less CSV rows resolved by name", () => {
    const [perfRow] = buildPerformanceLogRows({
      rows: [{ ...baseRow, name: "Ad A" }],
      adIdByMetaId: new Map(),
      adIdByName: new Map([["Ad A", "ad-a"]]),
      organizationId: "org-1",
    });

    expect(perfRow).toMatchObject({ adId: "ad-a", metaAdId: null });
    expect(toStagingPerfRow(perfRow!).meta_ad_id).toBeNull();
  });
});

describe("matchExistingAdsForImport", () => {
  it("adopts a legacy null-metaId ad instead of creating a duplicate", () => {
    const legacy = existingAd({ id: "ad-legacy", name: "Ad A" });

    const existingMap = matchExistingAdsForImport({
      adInfoMap: new Map([["meta-a", { name: "Ad A", metaAdId: "meta-a" }]]),
      existingByMetaId: new Map(),
      existingByName: new Map([["Ad A", legacy]]),
      adoptableByName: new Map([["Ad A", [legacy]]]),
    });

    expect(existingMap.get("meta-a")).toBe(legacy);
  });

  it("never claims a same-named ad that already has a different metaId", () => {
    const sibling = existingAd({ id: "ad-sibling", name: "Ad A", metaId: "meta-other" });

    const existingMap = matchExistingAdsForImport({
      adInfoMap: new Map([["meta-a", { name: "Ad A", metaAdId: "meta-a" }]]),
      existingByMetaId: new Map(),
      existingByName: new Map([["Ad A", sibling]]),
      adoptableByName: new Map(),
    });

    expect(existingMap.size).toBe(0);
  });

  it("lets only one incoming Meta ad adopt a given legacy row", () => {
    const legacy = existingAd({ id: "ad-legacy", name: "Ad A" });

    const existingMap = matchExistingAdsForImport({
      adInfoMap: new Map([
        ["meta-a", { name: "Ad A", metaAdId: "meta-a" }],
        ["meta-b", { name: "Ad A", metaAdId: "meta-b" }],
      ]),
      existingByMetaId: new Map(),
      existingByName: new Map([["Ad A", legacy]]),
      adoptableByName: new Map([["Ad A", [legacy]]]),
    });

    expect(existingMap.get("meta-a")).toBe(legacy);
    expect(existingMap.has("meta-b")).toBe(false);
  });

  it("prefers the metaId match over any name match", () => {
    const byMetaId = existingAd({ id: "ad-meta", name: "Renamed on Meta", metaId: "meta-a" });
    const byName = existingAd({ id: "ad-name", name: "Ad A" });

    const existingMap = matchExistingAdsForImport({
      adInfoMap: new Map([["meta-a", { name: "Ad A", metaAdId: "meta-a" }]]),
      existingByMetaId: new Map([["meta-a", byMetaId]]),
      existingByName: new Map([["Ad A", byName]]),
      adoptableByName: new Map([["Ad A", [byName]]]),
    });

    expect(existingMap.get("meta-a")).toBe(byMetaId);
  });

  it("still name-matches id-less rows", () => {
    const existing = existingAd({ id: "ad-a", name: "Ad A", metaId: "meta-a" });

    const existingMap = matchExistingAdsForImport({
      adInfoMap: new Map([["Ad A", { name: "Ad A" }]]),
      existingByMetaId: new Map(),
      existingByName: new Map([["Ad A", existing]]),
      adoptableByName: new Map(),
    });

    expect(existingMap.get("Ad A")).toBe(existing);
  });
});

describe("resolveAdsForRows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults = [];
    mocks.whereConditions = [];
  });

  it("looks names up only for id-less rows, scoped by account", async () => {
    mocks.selectResults = [
      [{ id: "ad-known", name: "Ad A", metaId: "meta-known" }],
      [{ id: "ad-csv", name: "CSV ad", metaId: null }],
    ];

    const { adIdByMetaId, adIdByName } = await resolveAdsForRows({
      organizationId: "org-1",
      accountId: "acct-1",
      rows: [
        { ...baseRow, name: "Ad A", adId: "meta-known" },
        { ...baseRow, name: "Ad B", adId: "meta-unknown" },
        { ...baseRow, name: "CSV ad" },
      ],
    });

    expect(adIdByMetaId.get("meta-known")).toBe("ad-known");
    expect(adIdByName.get("CSV ad")).toBe("ad-csv");

    const nameQuery = renderedWhere(1);
    expect(nameQuery.params).toContain("CSV ad");
    expect(nameQuery.params).not.toContain("Ad B");
    expect(nameQuery.params).toContain("acct-1");
    expect(nameQuery.sql).toContain('"account_id"');
  });

  it("skips the name query entirely when every row carries an ad id", async () => {
    mocks.selectResults = [[{ id: "ad-known", name: "Ad A", metaId: "meta-known" }]];

    const { adIdByName } = await resolveAdsForRows({
      organizationId: "org-1",
      accountId: "acct-1",
      rows: [
        { ...baseRow, name: "Ad A", adId: "meta-known" },
        { ...baseRow, name: "Ad A", adId: "meta-unknown" },
      ],
    });

    expect(adIdByName.size).toBe(0);
    expect(mocks.whereConditions).toHaveLength(1);
  });
});
