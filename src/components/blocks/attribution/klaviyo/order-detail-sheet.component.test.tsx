import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClaimsChain } from "./claims-chain";
import { JourneyTimeline } from "./journey-timeline";
import { OrderExplanation } from "./order-explanation";
import { ProductComparison } from "./product-comparison";
import { SourceInspector, type InspectorData } from "./source-inspector";

const noop = () => undefined;

describe("OrderExplanation", () => {
  it("shows matcher version, method, confidence, and offers no confirm action", () => {
    render(
      <OrderExplanation
        data={{
          orderId: "order-1",
          orderStatus: "ambiguous",
          matchRunId: "run-1",
          matcherVersion: "klaviyo-v1",
          reasonCodes: ["tie_between_candidates"],
          boundaryWarning: false,
          candidates: [
            {
              candidateId: "candidate-1",
              candidateClass: "diagnostic",
              method: "time_value",
              score: "6",
              confidence: "0.5",
              reasonCodes: [],
              selected: false,
            },
            {
              candidateId: "candidate-2",
              candidateClass: "diagnostic",
              method: "time_value",
              score: "6",
              confidence: "0.5",
              reasonCodes: [],
              selected: false,
            },
          ],
        }}
        selectedCandidateId={null}
        onInspectCandidate={noop}
      />,
    );
    expect(screen.getByText(/klaviyo-v1/)).toBeVisible();
    expect(screen.getByText(/tie_between_candidates/)).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Inspect edge" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
  });
});

describe("ProductComparison", () => {
  it("publishes a status only for canonical conversions and labels diagnostics", () => {
    const { rerender } = render(
      <ProductComparison
        data={{
          kind: "canonical",
          productStatus: "exact",
          links: [{ status: "exact", reasonCodes: [] }],
        }}
        candidateSelected={false}
      />,
    );
    expect(screen.getByText("Published product status")).toBeVisible();
    expect(screen.getByText("exact")).toBeVisible();

    rerender(
      <ProductComparison
        data={{ kind: "diagnostic", matcherVersion: "klaviyo-v1", comparison: {} }}
        candidateSelected={true}
      />,
    );
    expect(
      screen.getByText("Per-edge diagnostic — not a conclusion"),
    ).toBeVisible();
    expect(screen.queryByText("Published product status")).toBeNull();

    rerender(
      <ProductComparison
        data={{ kind: "non_canonical", orderStatus: "candidate" }}
        candidateSelected={false}
      />,
    );
    expect(screen.getByText(/No published product conclusion/)).toBeVisible();
  });
});

describe("JourneyTimeline", () => {
  it("labels journeys same Klaviyo profile with the merge caveat", () => {
    render(
      <JourneyTimeline
        data={{
          kind: "journey",
          label: "same_klaviyo_profile",
          events: [
            {
              eventRowId: "event-1",
              metricKind: "clicked_email",
              occurredAt: "2026-07-19T10:00:00.000Z",
            },
          ],
          clipped: true,
          caveats: ["profile_merge_possible", "clipped_to_ingested_coverage"],
        }}
        lookback={30}
        onLookbackChange={noop}
      />,
    );
    expect(screen.getByText("Same Klaviyo profile")).toBeVisible();
    expect(screen.queryByText(/same customer/i)).toBeNull();
    expect(screen.getByText(/profiles can merge/)).toBeVisible();
    expect(screen.getByText("Clipped to ingested journey coverage.")).toBeVisible();
    expect(screen.getByText("clicked_email")).toBeVisible();
  });
});

describe("ClaimsChain", () => {
  it("keeps unknown relationships unknown and opens never relabelled clicks", () => {
    render(
      <ClaimsChain
        data={{
          kind: "canonical",
          conversionEventId: "event-1",
          claims: [
            {
              attributionId: "attribution-1",
              campaign: null,
              flow: null,
              message: null,
              externalVariationReference: null,
              interaction: {
                type: "open",
                occurredAt: null,
                channel: "email",
                host: null,
                path: null,
                botClick: null,
              },
              unknownReasonCodes: ["marketing_source_unknown"],
            },
          ],
          replay: { status: "incomplete", reasonCodes: ["truncated"] },
          caveats: ["claims_stale_or_incomplete"],
        }}
      />,
    );
    expect(screen.getByText("Interaction: open")).toBeVisible();
    expect(screen.queryByText(/click/i)).toBeNull();
    expect(screen.getByText("Campaign or flow: Unknown")).toBeVisible();
    expect(screen.getByText("Message: Unknown")).toBeVisible();
    expect(screen.getByText("Stale or incomplete refresh")).toBeVisible();
    // Bot warning only when the source field exists (null here).
    expect(screen.queryByText("Bot click reported")).toBeNull();
  });

  it("labels diagnostic chains non-canonical", () => {
    render(
      <ClaimsChain
        data={{
          kind: "diagnostic",
          conversionEventId: "event-2",
          claims: [],
          replay: null,
          caveats: ["per_edge_diagnostic_non_canonical"],
        }}
      />,
    );
    expect(
      screen.getByText("Per-edge diagnostic — non-canonical"),
    ).toBeVisible();
  });
});

describe("SourceInspector", () => {
  it("never renders hostile raw fields even when the transport injects them", () => {
    const hostile = {
      order: {
        orderId: "order-1",
        orderName: "#1001",
        orderDay: "2026-07-20",
        lastClickUtm: { source: "klaviyo", medium: "email", campaign: null },
      },
      result: { status: "confirmed", matchRunId: "run-1", claimCount: 1 },
      candidateEdge: null,
      conversionEvent: {
        externalEventId: "external-1",
        occurredAt: "2026-07-20T10:00:00.000Z",
        productEvidenceCompleteness: "complete",
        warnings: ["redacted_properties_truncated"],
        profile: "present" as const,
      },
      caveats: [],
      // Hostile transport-injected fields at the response root.
      customerJourney: { moments: [{ landing: "https://x/?email=a@b.com" }] },
      email: "person@example.com",
      identityHmac: "deadbeef-digest",
      profileId: "profile-secret",
      privateKey: "pk_secret",
      rawPayload: '{"event_properties":{"$extra":"raw"}}',
      redactedProperties: { email: "nested@example.com" },
    } as InspectorData;
    const { container } = render(<SourceInspector data={hostile} />);
    const text = container.textContent ?? "";
    expect(text).toContain("external-1");
    expect(text).toContain("identity evidence present");
    expect(text).not.toContain("person@example.com");
    expect(text).not.toContain("nested@example.com");
    expect(text).not.toContain("deadbeef-digest");
    expect(text).not.toContain("profile-secret");
    expect(text).not.toContain("pk_secret");
    expect(text).not.toContain("$extra");
    expect(text).not.toContain("customerJourney");
  });

  it("shows the safe truncation warning without enumerating omitted keys", () => {
    render(
      <SourceInspector
        data={{
          order: {
            orderId: "order-1",
            orderName: null,
            orderDay: "2026-07-20",
            lastClickUtm: { source: null, medium: null, campaign: null },
          },
          result: null,
          candidateEdge: null,
          conversionEvent: {
            externalEventId: "external-1",
            occurredAt: "2026-07-20T10:00:00.000Z",
            productEvidenceCompleteness: "incomplete",
            warnings: ["redacted_properties_truncated"],
            profile: "absent",
          },
          caveats: [],
        }}
      />,
    );
    expect(
      screen.getByText(/truncated by the server-side redaction bound/),
    ).toBeVisible();
    expect(screen.queryByText(/omitted key/i)).toBeNull();
  });

  it("offers copy only for the event external ID", async () => {
    const copy = vi.fn();
    render(
      <SourceInspector
        data={{
          order: {
            orderId: "order-1",
            orderName: null,
            orderDay: "2026-07-20",
            lastClickUtm: { source: null, medium: null, campaign: null },
          },
          result: null,
          candidateEdge: null,
          conversionEvent: {
            externalEventId: "external-1",
            occurredAt: "2026-07-20T10:00:00.000Z",
            productEvidenceCompleteness: "complete",
            warnings: [],
            profile: "present",
          },
          caveats: [],
        }}
        onCopyEventId={copy}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("Copy event ID");
  });
});
