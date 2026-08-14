import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompetitorCard } from "./competitor-card";
import type { Competitor } from "./types";

function makeCompetitor(overrides: Partial<Competitor> = {}): Competitor {
  return {
    id: "c1",
    name: "AIRWAAV",
    metaPageId: "123456789",
    activeAdCount: 0,
    oldestStartDate: null,
    clusterCount: 0,
    topClusters: [],
    lastFill: null,
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

  it("shows stats, tiered clusters and the last-fill line once filled", () => {
    const filledAt = new Date();
    filledAt.setHours(filledAt.getHours() - 3);
    const oldest = new Date();
    oldest.setDate(oldest.getDate() - 105);

    render(
      <CompetitorCard
        competitor={makeCompetitor({
          activeAdCount: 143,
          oldestStartDate: oldest,
          clusterCount: 4,
          topClusters: [
            {
              id: "cl1",
              label: "Coach endorsement",
              angle: "social_proof",
              tier: "high",
              score: 82,
            },
            {
              id: "cl2",
              label: "Unscored copy",
              angle: null,
              tier: null,
              score: null,
            },
          ],
          lastFill: {
            filledAt,
            adCount: 143,
            source: "meta_ads_collector",
            pipelineStatus: "complete",
            error: null,
          },
        })}
        onArchive={vi.fn()}
        archiveDisabled={false}
      />,
    );

    expect(screen.getByText("143")).toBeVisible();
    expect(screen.getByText("105d")).toBeVisible();
    expect(screen.getByText("High")).toBeVisible();
    expect(screen.getByText("Unscored copy")).toBeVisible();
    expect(screen.queryByText("Watch")).toBeNull();
    expect(
      screen.getByText(/Last filled about 3 hours ago · 143 ads · MetaAdsCollector/),
    ).toBeVisible();
  });

  it("surfaces the pipeline error instead of the fill summary when a fill failed", () => {
    render(
      <CompetitorCard
        competitor={makeCompetitor({
          lastFill: {
            filledAt: new Date(),
            adCount: 12,
            source: "scrapecreators",
            pipelineStatus: "failed",
            error: "mirror pipeline failed to start",
          },
        })}
        onArchive={vi.fn()}
        archiveDisabled={false}
      />,
    );

    expect(
      screen.getByText(/failed — mirror pipeline failed to start/),
    ).toBeVisible();
    expect(screen.queryByText(/Last filled/)).toBeNull();
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
