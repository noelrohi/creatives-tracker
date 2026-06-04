import { describe, expect, it } from "vitest";
import {
  buildLaunchpadLocalAdHref,
  buildMetaAdsManagerAdUrl,
  canShowLaunchpadManualInterventionAction,
  canShowLaunchpadRetryAction,
  getLaunchpadItemDiagnostics,
  getLaunchpadItemManifestSummary,
  getLaunchpadPerformanceSyncReadiness,
  getLaunchpadRunAggregateResult,
  getLaunchpadStatusBreakdown,
  type LaunchpadRunDetailItem,
  type LaunchpadRunDetailRun,
} from "./launchpad-run-detail";

function run(overrides: Partial<LaunchpadRunDetailRun> = {}): LaunchpadRunDetailRun {
  return {
    id: "run-1",
    status: "validated",
    itemCount: 1,
    ...overrides,
  };
}

function item(overrides: Partial<LaunchpadRunDetailItem> = {}): LaunchpadRunDetailItem {
  return {
    id: "item-1",
    position: 1,
    status: "validated",
    creativeId: "creative-1",
    requestedStatus: "PAUSED",
    payload: {
      creative: {
        id: "creative-1",
        name: "Static winner",
        format: "static",
      },
      launch: {
        adName: "Launchpad / Static winner",
        adNameSource: "template",
        primaryText: "Primary text",
        headline: "Hook headline",
        headlineSource: "creative_hook",
        destinationUrl:
          "https://example.com/products?utm_source=meta&utm_medium=paid_social",
        cta: "SHOP_NOW",
        ctaSource: "default",
        requestedStatus: "PAUSED",
      },
      url: {
        finalUrl:
          "https://example.com/products?utm_source=meta&utm_medium=paid_social",
        source: "batch_default",
      },
      safety: {
        localAdStatus: "paused",
        metaAdStatus: "PAUSED",
      },
    },
    ...overrides,
  };
}

describe("Launchpad run detail presentation", () => {
  it("summarizes item status counts and aggregate result copy", () => {
    const items = [
      item({ id: "item-1", status: "success" }),
      item({ id: "item-2", status: "failed" }),
      item({ id: "item-3", status: "ambiguous" }),
    ];

    const result = getLaunchpadRunAggregateResult(
      run({ status: "partial_success" }),
      items,
    );

    expect(result).toMatchObject({
      label: "Partial success",
      tone: "warning",
      counts: { success: 1, failed: 1, ambiguous: 1 },
    });
    expect(result.detail).toContain("1/3 items succeeded");
  });

  it("extracts manifest summary fields operators need to audit an item", () => {
    const summary = getLaunchpadItemManifestSummary(item());

    expect(summary).toMatchObject({
      creativeId: "creative-1",
      creativeName: "Static winner",
      adName: "Launchpad / Static winner",
      finalUrl:
        "https://example.com/products?utm_source=meta&utm_medium=paid_social",
      cta: "SHOP_NOW",
      requestedStatus: "PAUSED",
      plannedLocalStatus: "paused",
    });
  });

  it("keeps raw Meta configured/effective status separate from local paused status", () => {
    const statuses = getLaunchpadStatusBreakdown(
      item({
        status: "success",
        localAdId: "local-ad-1",
        localAd: {
          id: "local-ad-1",
          status: "paused",
          rawMetaConfiguredStatus: "PAUSED",
          rawMetaEffectiveStatus: "IN_PROCESS",
        },
        rawMetaConfiguredStatus: "PAUSED",
        rawMetaEffectiveStatus: "IN_PROCESS",
      }),
    );

    expect(statuses.local).toEqual({
      label: "Local ad: paused",
      status: "paused",
    });
    expect(statuses.meta).toEqual({
      configured: "PAUSED",
      effective: "IN_PROCESS",
    });
    expect(statuses.local.label).not.toContain("IN_PROCESS");
  });

  it("builds local ad and Ads Manager links from safe IDs only", () => {
    expect(
      buildLaunchpadLocalAdHref(
        item({ localAdId: "local-ad-1", creativeId: "creative with spaces" }),
      ),
    ).toBe("/creatives/creative-1?tab=ads");

    const url = buildMetaAdsManagerAdUrl({
      accountMetaId: "act_1234567890",
      adMetaId: "23800000000000000",
    });

    expect(url).toBe(
      "https://www.facebook.com/adsmanager/manage/ads?act=1234567890&selected_ad_ids=23800000000000000",
    );
    expect(
      buildMetaAdsManagerAdUrl({
        accountMetaId: "act_1234567890",
        adMetaId: "23800000000000000&unexpected_param=1",
      }),
    ).toBeNull();
    expect(
      buildMetaAdsManagerAdUrl({
        accountMetaId: "https://evil.example/act_123",
        adMetaId: "23800000000000000",
      }),
    ).toBeNull();
  });

  it("shows retry only for run states with retry or reconciliation candidates", () => {
    expect(canShowLaunchpadRetryAction(run({ status: "validated" }), [item()])).toBe(false);
    expect(
      canShowLaunchpadRetryAction(run({ status: "failed" }), [
        item({
          status: "failed",
          errorCategory: "retryable",
          externalMetaAdId: null,
        }),
      ]),
    ).toBe(true);
    expect(
      canShowLaunchpadRetryAction(run({ status: "partial_success" }), [
        item({ status: "success", externalMetaAdId: "23800000000000000" }),
        item({ status: "failed", errorCategory: "terminal" }),
      ]),
    ).toBe(false);
    expect(
      canShowLaunchpadRetryAction(run({ status: "ambiguous" }), [
        item({ status: "ambiguous", errorCategory: "ambiguous" }),
      ]),
    ).toBe(true);
  });

  it("shows manual-intervention affordances only for unresolved or stuck item states", () => {
    expect(canShowLaunchpadManualInterventionAction(item({ status: "validated" }))).toBe(false);
    expect(canShowLaunchpadManualInterventionAction(item({ status: "queued" }))).toBe(true);
    expect(canShowLaunchpadManualInterventionAction(item({ status: "publishing" }))).toBe(true);
    expect(canShowLaunchpadManualInterventionAction(item({ status: "failed" }))).toBe(true);
    expect(
      canShowLaunchpadManualInterventionAction(
        item({ status: "success", externalMetaAdId: "23800000000000000" }),
      ),
    ).toBe(false);
  });

  it("renders operator diagnostics from error, reconciliation, manual, and retry fields", () => {
    const diagnostics = getLaunchpadItemDiagnostics(
      item({
        status: "manual_intervention",
        errorCategory: "manual_intervention",
        errorCode: "META_AD_CREATE_UNRESOLVED",
        errorMessage: "Inspect Meta Ads Manager before retrying",
        errorDetails: { previousStatus: "ambiguous" },
        reconciliationStatus: "manual_intervention",
        manualInterventionReason: "Meta may have created the ad without returning an ID",
        retryCount: 2,
        lastRetryRequestedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Classification", value: "manual intervention" }),
        expect.objectContaining({ label: "Error META_AD_CREATE_UNRESOLVED" }),
        expect.objectContaining({ label: "Details", value: expect.stringContaining("previousStatus") }),
        expect.objectContaining({ label: "Reconciliation", value: "manual intervention" }),
        expect.objectContaining({ label: "Manual intervention" }),
        expect.objectContaining({ label: "Retries", value: expect.stringContaining("2") }),
      ]),
    );
  });

  it("explains performance sync readiness without adding analytics charts", () => {
    expect(getLaunchpadPerformanceSyncReadiness(item())).toMatchObject({
      ready: false,
      label: "Waiting for Meta ad ID",
    });
    expect(
      getLaunchpadPerformanceSyncReadiness(
        item({ externalMetaAdId: "23800000000000000", localAdId: null }),
      ),
    ).toMatchObject({
      ready: false,
      tone: "warning",
    });
    expect(
      getLaunchpadPerformanceSyncReadiness(
        item({
          externalMetaAdId: "23800000000000000",
          localAdId: "local-ad-1",
        }),
      ),
    ).toMatchObject({
      ready: true,
      label: "Ready for Meta sync linkage",
      message: expect.stringContaining("Existing Meta performance sync"),
    });
  });
});
