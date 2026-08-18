import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { EvidencePanel } from "./evidence-panel";
import type { RankedSignal } from "./types";

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

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
    creativeCount: 16,
    representativeCopy: "Every rep counts.",
    oldestStartDate: daysAgo(105),
    previewAds: [
      {
        archiveId: "a1",
        thumbnailUrl: "https://blob.test/a1.jpg",
        isVideo: false,
        videoUrl: null,
      },
      {
        archiveId: "a2",
        thumbnailUrl: "https://blob.test/a2.jpg",
        isVideo: true,
        videoUrl: "https://blob.test/a2.mp4",
      },
    ],
    ...overrides,
  };
}

describe("EvidencePanel", () => {
  it("leads with the score, the tier in words, and plain-language meters", () => {
    render(<EvidencePanel signal={makeSignal()} />);

    expect(screen.getByText("70")).toBeVisible();
    expect(screen.getByText("of 100")).toBeVisible();
    expect(screen.getByText("Strong signal")).toBeVisible();
    expect(screen.getByText("AIRWAAV · Social proof")).toBeVisible();
    // Every meter carries a human phrase, never points/max. Variations counts
    // creatives (primary + variants), not member ads.
    expect(screen.getByText("on air 105 days")).toBeVisible();
    expect(screen.getByText("16 versions running")).toBeVisible();
    expect(screen.getByText("aims straight at your space")).toBeVisible();
    expect(screen.getByText("images + video")).toBeVisible();
    expect(screen.getByText("57% to one page")).toBeVisible();
    expect(screen.queryByText(/\/35/)).toBeNull();
    expect(
      screen.getByText(/reinforces the athlete-credibility positioning/),
    ).toBeVisible();
  });

  it("links each preview ad to its own Ad Library detail page", () => {
    render(<EvidencePanel signal={makeSignal()} />);

    const adLinks = screen.getAllByRole("link", {
      name: "View ad in Meta Ad Library",
    });
    expect(adLinks).toHaveLength(2);
    expect(adLinks[0]).toHaveAttribute(
      "href",
      "https://www.facebook.com/ads/library/?id=a1",
    );
    // The mirrored video plays in-app rather than dead-ending on a badge.
    expect(screen.getByRole("button", { name: "Play video" })).toBeVisible();
    // Two previews of seven ads: the overflow tile and the "see all" link both
    // route to the in-app grid, pre-filtered to this signal's theme.
    const themedHref = "/competitors/c1?theme=Coach%20endorsement";
    expect(screen.getByText("+5")).toHaveAttribute("href", themedHref);
    expect(screen.getByRole("link", { name: "See all 7" })).toHaveAttribute(
      "href",
      themedHref,
    );
  });

  it("flags a cluster whose verdict never validated and still meters relevance at 0", () => {
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

    expect(screen.getByText("Read unavailable")).toBeVisible();
    expect(
      screen.getByText(/relevance counts 0 until the next one/),
    ).toBeVisible();
    expect(screen.getByText("not assessed")).toBeVisible();
    expect(screen.getByText("Promising")).toBeVisible();
  });

  it("dashes the dial and phrases for an unscored cluster", () => {
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
          oldestStartDate: null,
          previewAds: [],
        })}
      />,
    );

    expect(screen.getByText("Not scored yet")).toBeVisible();
    expect(screen.getByText("not assessed")).toBeVisible();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("Strong signal")).toBeNull();
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
    expect(
      screen.getByRole("link", { name: /Open in Ad Library/ }),
    ).toHaveAttribute(
      "href",
      "https://www.facebook.com/ads/library/?view_all_page_id=123456789",
    );
  });

  it("explains the scoring formula behind a 'How it's scored' popover", async () => {
    render(<EvidencePanel signal={makeSignal()} />);

    await userEvent.click(
      screen.getByRole("button", { name: /How it.s scored/ }),
    );

    expect(screen.getByText(/out of 100 points/)).toBeVisible();
    // One plain-language entry per meter, weights included.
    expect(screen.getByText("up to 35 pts")).toBeVisible();
    expect(screen.getByText(/oldest ad still running/)).toBeVisible();
    expect(screen.getByText("up to 10 pts")).toBeVisible();
    // Tier cutoffs and the honesty note travel with the formula.
    expect(screen.getByText(/65\+ reads as/)).toBeVisible();
    expect(
      screen.getByText(/not how it performed/),
    ).toBeVisible();
  });
});
