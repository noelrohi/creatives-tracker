import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EvidencePanel } from "./evidence-panel";
import type { RankedSignal } from "./types";

function makeSignal(overrides: Partial<RankedSignal> = {}): RankedSignal {
  return {
    id: "cl1",
    label: "Coach endorsement",
    angle: "social_proof",
    summary: "Coaches vouch for the mouthguard",
    adCount: 7,
    score: 70.4,
    tier: "high",
    longevityPoints: 25.9,
    variantPoints: 18.2,
    strategicPoints: 15,
    formatPoints: 10,
    landingPoints: 1.3,
    verdict: "high",
    verdictRationale: "Directly reinforces the athlete-credibility positioning.",
    competitor: { id: "c1", name: "AIRWAAV", metaPageId: "123456789" },
    formatsObserved: ["image", "video"],
    landingFocusUrl: "https://airwaav.com/products/performance-mouthpiece",
    landingFocusShare: 0.57,
    representativeCopy: "Every rep counts.",
    ...overrides,
  };
}

describe("EvidencePanel", () => {
  it("leads with the rounded score, tier, meters and the strategic read", () => {
    render(<EvidencePanel signal={makeSignal()} />);

    expect(screen.getByText("70")).toBeVisible();
    expect(screen.getByText("High")).toBeVisible();
    expect(screen.getByText("AIRWAAV · Social proof")).toBeVisible();
    expect(screen.getByText("25.9/35")).toBeVisible();
    expect(screen.getByText("18.2/25")).toBeVisible();
    expect(screen.getByText("15.0/15")).toBeVisible();
    expect(screen.getByText("10.0/15")).toBeVisible();
    expect(screen.getByText("1.3/10")).toBeVisible();
    expect(
      screen.getByText(/reinforces the athlete-credibility positioning/),
    ).toBeVisible();
  });

  it("flags a cluster whose verdict never validated and still meters strategic at 0", () => {
    render(
      <EvidencePanel
        signal={makeSignal({
          verdict: null,
          verdictRationale: null,
          strategicPoints: 0,
          score: 55.4,
          tier: "moderate",
        })}
      />,
    );

    expect(screen.getByText("Strategic read unavailable")).toBeVisible();
    expect(
      screen.getByText(/strategic contributes 0 until the next fill/),
    ).toBeVisible();
    expect(screen.getByText("0.0/15")).toBeVisible();
    expect(screen.getByText("Moderate")).toBeVisible();
  });

  it("dashes the dial and null components for an unscored cluster", () => {
    render(
      <EvidencePanel
        signal={makeSignal({
          score: null,
          tier: null,
          longevityPoints: null,
          variantPoints: null,
          strategicPoints: null,
          formatPoints: null,
          landingPoints: null,
          verdict: null,
          verdictRationale: null,
          formatsObserved: [],
          landingFocusUrl: null,
          landingFocusShare: 0,
        })}
      />,
    );

    expect(screen.getByText("Not scored yet")).toBeVisible();
    expect(screen.getByText("0.0/35")).toBeVisible();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("High")).toBeNull();
  });

  it("shows the compact facts and links out to the competitor's Ad Library", () => {
    render(<EvidencePanel signal={makeSignal()} />);

    expect(screen.getByText("7")).toBeVisible();
    expect(screen.getByText("Image, Video")).toBeVisible();
    expect(
      screen.getByText(
        "https://airwaav.com/products/performance-mouthpiece (57%)",
      ),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /Ad Library/ })).toHaveAttribute(
      "href",
      "https://www.facebook.com/ads/library/?view_all_page_id=123456789",
    );
  });
});
