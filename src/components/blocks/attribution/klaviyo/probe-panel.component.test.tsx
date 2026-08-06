import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProbePanel, type JoinRuleRow, type ProbeReportRow } from "./probe-panel";
import { SyncRunsPanel, type SyncRunRow } from "./sync-runs-panel";
import { LabHeader } from "./lab-header";

function report(overrides: Partial<ProbeReportRow> = {}): ProbeReportRow {
  return {
    id: "report-1",
    status: "pending",
    sampledFrom: "2026-07-01T00:00:00Z",
    sampledTo: "2026-07-30T00:00:00Z",
    sampledShopifyOrders: 30,
    sampledKlaviyoEvents: 25,
    bindingOverlapCount: 25,
    identifierCoverage: { orderId: 25 },
    collisionSummary: { orderId: 0 },
    productCoverage: { complete: 20 },
    attributionCoverage: { withAttribution: 12 },
    reviewNote: null,
    ...overrides,
  };
}

function rule(overrides: Partial<JoinRuleRow> = {}): JoinRuleRow {
  return {
    id: "rule-1",
    eventKind: "placed_order",
    sourceProperty: "$event_id",
    targetNamespace: "shopify_order_gid",
    canonicalizer: "trimmed_exact",
    state: "candidate",
    observedPopulated: 25,
    observedCollisions: 0,
    ...overrides,
  };
}

const noop = () => undefined;

describe("ProbePanel", () => {
  it("shows sampled orders, field coverage, collisions, product and claim coverage", () => {
    render(
      <ProbePanel
        reports={[report()]}
        rules={[]}
        busy={false}
        onRunProbe={noop}
        onReviewProbe={noop}
        onReviewRule={noop}
      />,
    );
    expect(
      screen.getByText(/Sampled 30 Shopify orders and 25 Klaviyo events/),
    ).toBeVisible();
    expect(screen.getByText("Field coverage")).toBeVisible();
    expect(screen.getByText("Collisions")).toBeVisible();
    expect(screen.getByText("Product coverage")).toBeVisible();
    expect(screen.getByText("Claim coverage")).toBeVisible();
  });

  it("requires a review note before approving or rejecting the probe", async () => {
    const review = vi.fn();
    render(
      <ProbePanel
        reports={[report()]}
        rules={[]}
        busy={false}
        onRunProbe={noop}
        onReviewProbe={review}
        onReviewRule={noop}
      />,
    );
    const approve = screen.getByRole("button", { name: "Approve probe" });
    const reject = screen.getByRole("button", { name: "Reject probe" });
    expect(approve).toBeDisabled();
    expect(reject).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Probe review note"),
      "Verified coverage",
    );
    await userEvent.click(approve);
    expect(review).toHaveBeenCalledWith({
      reportId: "report-1",
      decision: "approve",
      reviewNote: "Verified coverage",
    });
  });

  it("requires a note, a passed probe, and zero collisions to approve a rule", async () => {
    const reviewRule = vi.fn();
    const { rerender } = render(
      <ProbePanel
        reports={[report()]}
        rules={[rule()]}
        busy={false}
        onRunProbe={noop}
        onReviewProbe={noop}
        onReviewRule={reviewRule}
      />,
    );
    // Pending probe: approval unavailable even with a note.
    await userEvent.type(
      screen.getByLabelText("Rule review note rule-1"),
      "Looks safe",
    );
    expect(screen.getByRole("button", { name: "Approve rule" })).toBeDisabled();

    rerender(
      <ProbePanel
        reports={[report({ status: "passed" })]}
        rules={[rule({ observedCollisions: 2 })]}
        busy={false}
        onRunProbe={noop}
        onReviewProbe={noop}
        onReviewRule={reviewRule}
      />,
    );
    expect(screen.getByRole("button", { name: "Approve rule" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject rule" })).toBeEnabled();

    rerender(
      <ProbePanel
        reports={[report({ status: "passed" })]}
        rules={[rule()]}
        busy={false}
        onRunProbe={noop}
        onReviewProbe={noop}
        onReviewRule={reviewRule}
      />,
    );
    // The stored canonicalization is read-only text, never an input.
    expect(screen.getByText("trimmed_exact")).toBeVisible();
    expect(screen.queryByDisplayValue("trimmed_exact")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Approve rule" }));
    expect(reviewRule).toHaveBeenCalledWith({
      ruleId: "rule-1",
      decision: "approve",
      reviewNote: "Looks safe",
    });
  });
});

describe("SyncRunsPanel", () => {
  const hostileRun = {
    id: "run-1",
    operation: "events",
    status: "failed",
    requestedFrom: "2026-07-01T00:00:00Z",
    requestedTo: "2026-07-30T00:00:00Z",
    rowsRead: 100,
    rowsInserted: 90,
    rowsUpdated: 5,
    rowsIgnored: 5,
    warningCount: 1,
    failureCount: 1,
    errorCode: "KLAVIYO_SYNC_FAILED",
    errorMessage: "Klaviyo sync did not complete",
    checkpointSummary: { sourceMode: "order_core", metricIndex: 1, page: 3 },
    startedAt: "2026-07-30T10:00:00Z",
    finishedAt: "2026-07-30T10:05:00Z",
    // Hostile transport-added fields must never render.
    cursor: "attacker@example.com",
    rawCheckpoint: '{"cursor":"secret-cursor"}',
  } as SyncRunRow;

  it("renders only safe checkpoint mode index and page, never provider cursors", () => {
    const { container } = render(
      <SyncRunsPanel
        runs={[hostileRun]}
        error={false}
        stale={false}
        onRetry={noop}
      />,
    );
    expect(screen.getByText("order_core · metric 1 · page 3")).toBeVisible();
    expect(screen.getByText("KLAVIYO_SYNC_FAILED")).toBeVisible();
    expect(container.textContent).not.toContain("attacker@example.com");
    expect(container.textContent).not.toContain("secret-cursor");
  });

  it("keeps prior rows visible with a stale banner when refetch fails", () => {
    render(
      <SyncRunsPanel
        runs={[hostileRun]}
        error={true}
        stale={true}
        onRetry={noop}
      />,
    );
    expect(
      screen.getByText("Refresh failed — showing previously loaded runs."),
    ).toBeVisible();
    expect(screen.getByText("events")).toBeVisible();
  });
});

describe("LabHeader", () => {
  it("starts discovery from the environment-backed empty-connection state", async () => {
    const start = vi.fn();
    render(
      <LabHeader
        health={{ configured: false, store: null, connection: null }}
        healthError={false}
        onRetryHealth={noop}
        busy={false}
        syncPending={false}
        recomputePending={false}
        syncLocked={false}
        recomputeLocked={false}
        onStartDiscovery={start}
        onSyncNow={noop}
        onRecompute={noop}
      />,
    );
    expect(screen.queryByText(/credential/i)).not.toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Discover connection" }),
    );
    expect(start).toHaveBeenCalledOnce();
  });

  it("distinguishes missing connection from a health query failure", async () => {
    const retry = vi.fn();
    render(
      <LabHeader
        health={null}
        healthError={true}
        onRetryHealth={retry}
        busy={false}
        syncPending={false}
        recomputePending={false}
        syncLocked={false}
        recomputeLocked={false}
        onStartDiscovery={noop}
        onSyncNow={noop}
        onRecompute={noop}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Discover connection" }),
    ).toBeNull();
  });

  it("keeps recompute locked while the scoped invocation is unresolved", () => {
    render(
      <LabHeader
        health={{
          configured: true,
          store: {
            shopDomain: "a.example.com",
            ianaTimezone: "America/New_York",
            todayInStoreTz: "2026-07-31",
          },
          connection: {
            status: "ready",
            accountName: "Reviv",
            timezone: "America/Los_Angeles",
            currency: "USD",
            todayInAccountTz: "2026-07-31",
            lastDiscoverySyncedAt: null,
            lastEventSyncedAt: null,
            lastMatchPublishedAt: null,
          },
        }}
        healthError={false}
        onRetryHealth={noop}
        busy={false}
        syncPending={false}
        recomputePending={false}
        syncLocked={false}
        recomputeLocked={true}
        onStartDiscovery={noop}
        onSyncNow={noop}
        onRecompute={noop}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Recompute matches" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
  });
});
