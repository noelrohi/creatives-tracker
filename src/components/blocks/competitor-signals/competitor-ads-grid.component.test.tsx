import { render, screen } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { describe, expect, it } from "vitest";
import { CompetitorAdsGrid } from "./competitor-ads-grid";
import type { CompetitorAd, CompetitorAdsData } from "./types";

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function makeAd(overrides: Partial<CompetitorAd> = {}): CompetitorAd {
  return {
    id: "ad1",
    archiveId: "a1",
    startDate: daysAgo(30),
    displayFormat: "IMAGE",
    mediaKinds: ["image"],
    thumbnailUrl: "https://blob.test/a1.jpg",
    isVideo: false,
    videoUrl: null,
    theme: "Coach endorsement",
    ...overrides,
  };
}

function makeData(ads: CompetitorAd[]): CompetitorAdsData {
  return {
    competitor: { id: "c1", name: "AIRWAAV", metaPageId: "123456789" },
    updatedAt: daysAgo(1),
    ads,
  };
}

function renderGrid(data: CompetitorAdsData, searchParams = "") {
  return render(
    <NuqsTestingAdapter searchParams={searchParams}>
      <CompetitorAdsGrid data={data} />
    </NuqsTestingAdapter>,
  );
}

describe("CompetitorAdsGrid", () => {
  const ads = [
    makeAd({ id: "ad1", archiveId: "a1", theme: "Coach endorsement" }),
    makeAd({ id: "ad2", archiveId: "a2", theme: "Coach endorsement" }),
    makeAd({ id: "ad3", archiveId: "a3", theme: "Sleep science" }),
  ];

  it("shows every live ad without filters", () => {
    renderGrid(makeData(ads));

    expect(screen.getByText("3 ads")).toBeVisible();
    expect(
      screen.getAllByRole("link", { name: /View in Ad Library/ }),
    ).toHaveLength(3);
  });

  it("narrows to one theme when landed on via ?theme= (the signal's See all link)", () => {
    renderGrid(makeData(ads), "?theme=Coach%20endorsement");

    expect(screen.getByText("2 ads")).toBeVisible();
    expect(
      screen.getAllByRole("link", { name: /View in Ad Library/ }),
    ).toHaveLength(2);
  });

  it("names the medium a DCO container actually carries", () => {
    renderGrid(
      makeData([
        makeAd({ id: "ad1", displayFormat: "DCO", mediaKinds: ["video"] }),
        makeAd({ id: "ad2", displayFormat: "DCO", mediaKinds: [] }),
      ]),
    );

    expect(screen.getByText("Video · dynamic")).toBeVisible();
    // Legacy rows carry no media kinds — nothing to resolve, so the container stands.
    expect(screen.getByText("Dynamic")).toBeVisible();
  });

  it("buckets every dynamic video ad under the Video filter, mixed media included", () => {
    renderGrid(
      makeData([
        makeAd({ id: "ad1", displayFormat: "VIDEO" }),
        makeAd({ id: "ad2", displayFormat: "DCO", mediaKinds: ["video"] }),
        makeAd({
          id: "ad3",
          displayFormat: "DCO",
          mediaKinds: ["image", "video"],
        }),
        makeAd({ id: "ad4", displayFormat: "IMAGE" }),
      ]),
      "?format=Video",
    );

    expect(screen.getByText("3 ads")).toBeVisible();
    expect(
      screen.getAllByRole("link", { name: /View in Ad Library/ }),
    ).toHaveLength(3);
    expect(screen.getByText("Video · dynamic")).toBeVisible();
    expect(screen.getByText("Image + video · dynamic")).toBeVisible();
  });

  it("renders a stale linked theme as an explicit zero, not a blank control", () => {
    renderGrid(makeData(ads), "?theme=Retired%20message");

    expect(screen.getByText("0 ads")).toBeVisible();
    expect(screen.getByText("No ads match these filters")).toBeVisible();
    // The select still names the theme the link asked for.
    expect(
      screen.getByRole("combobox", { name: "Theme filter" }),
    ).toHaveTextContent("Retired message");
  });
});
