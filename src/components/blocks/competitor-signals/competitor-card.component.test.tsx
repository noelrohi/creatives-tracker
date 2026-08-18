import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompetitorCard } from "./competitor-card";
import type { Competitor } from "./types";

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function makeCompetitor(overrides: Partial<Competitor> = {}): Competitor {
  return {
    id: "c1",
    name: "AIRWAAV",
    metaPageId: "123456789",
    activeAdCount: 0,
    oldestStartDate: null,
    clusterCount: 0,
    recentAds: [],
    topClusters: [],
    lastFill: null,
    lastSuccessfulFillAt: null,
    ...overrides,
  };
}

describe("CompetitorCard", () => {
  it("dashes empty stats and points a never-filled card at the operator", () => {
    render(
      <CompetitorCard
        competitor={makeCompetitor()}
        onArchive={vi.fn()}
        archiveDisabled={false}
      />,
    );

    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(
      screen.getByText(/data arrives when the operator runs a fill/i),
    ).toBeVisible();
  });

  it("shows plain-word stats, the creative strip and tiered themes once filled", () => {
    const filledAt = new Date();
    filledAt.setHours(filledAt.getHours() - 3);

    render(
      <CompetitorCard
        competitor={makeCompetitor({
          activeAdCount: 143,
          oldestStartDate: daysAgo(105),
          clusterCount: 4,
          recentAds: [
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
          topClusters: [
            {
              id: "cl1",
              label: "Coach endorsement",
              angle: "social_proof",
              tier: "high",
              score: 82,
              adCount: 12,
              oldestStartDate: daysAgo(105),
            },
            {
              id: "cl2",
              label: "Unscored copy",
              angle: null,
              tier: null,
              score: null,
              adCount: 3,
              oldestStartDate: null,
            },
          ],
          lastFill: {
            filledAt,
            adCount: 143,
            source: "meta_ads_collector",
            pipelineStatus: "complete",
            error: null,
          },
          lastSuccessfulFillAt: filledAt,
        })}
        onArchive={vi.fn()}
        archiveDisabled={false}
      />,
    );

    expect(screen.getByText("143")).toBeVisible();
    expect(screen.getByText("105 days")).toBeVisible();
    expect(
      screen.getByText(/Updated about 3 hours ago · 143 ads/),
    ).toBeVisible();
    // The creative strip shows both mirrored thumbnails plus the overflow
    // tile, and the mirrored video is playable right on the card.
    expect(screen.getAllByAltText("AIRWAAV ad")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Play video" })).toBeVisible();
    expect(screen.getByText("+141")).toBeVisible();
    // Tiers read as words, and each theme carries its days · ads line.
    expect(screen.getByText("Strong signal")).toBeVisible();
    expect(screen.getByText("105 days · 12 ads")).toBeVisible();
    expect(screen.getByText("Unscored copy")).toBeVisible();
    expect(screen.queryByText("Early")).toBeNull();
    // Both outbound paths: the in-app grid and the Ad Library page view.
    expect(
      screen.getByRole("link", { name: /View all 143 ads/ }),
    ).toHaveAttribute("href", "/competitors/c1");
    expect(
      screen.getByRole("link", { name: /Meta Ad Library/ }),
    ).toHaveAttribute(
      "href",
      "https://www.facebook.com/ads/library/?view_all_page_id=123456789",
    );
  });

  it("explains a failed fill in plain words and dates the data it still shows", () => {
    render(
      <CompetitorCard
        competitor={makeCompetitor({
          lastFill: {
            filledAt: daysAgo(1),
            adCount: 12,
            source: "scrapecreators",
            pipelineStatus: "failed",
            error: "mirror pipeline failed to start",
          },
          lastSuccessfulFillAt: new Date("2026-08-16T09:00:00Z"),
        })}
        onArchive={vi.fn()}
        archiveDisabled={false}
      />,
    );

    expect(screen.getByText(/Update failed 1 day ago/)).toBeVisible();
    expect(screen.getByText(/showing Aug 16 data/)).toBeVisible();
    // The fill's own error rides along — it's the only place it surfaces.
    expect(
      screen.getByText(/mirror pipeline failed to start/),
    ).toBeVisible();
  });

  it("archives from the card menu", async () => {
    const archive = vi.fn();
    render(
      <CompetitorCard
        competitor={makeCompetitor()}
        onArchive={archive}
        archiveDisabled={false}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Card actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Archive/ }));
    expect(archive).toHaveBeenCalledWith("c1");
  });
});
