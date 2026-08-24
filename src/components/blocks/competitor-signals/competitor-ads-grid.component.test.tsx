import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { describe, expect, it, vi } from "vitest";
import { CompetitorAdsGrid } from "./competitor-ads-grid";
import type { CompetitorAd, CompetitorAdsData } from "./types";

const mutate = vi.fn();

// The grid writes through one procedure; the client is stubbed to the shapes it
// reaches for, and `mutate` records the payload.
vi.mock("@/lib/trpc/client", () => ({
  useTRPC: () => ({
    signals: {
      listCompetitorAds: { queryKey: () => ["listCompetitorAds"] },
      setAdWorkflowStatus: {
        mutationOptions: (options: unknown) => ({
          ...(options as object),
          mutationKey: ["setAdWorkflowStatus"],
          mutationFn: (input: unknown) => {
            mutate(input);
            return Promise.resolve({ updated: 0 });
          },
        }),
      },
    },
  }),
}));

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
    workflowStatus: "inbox",
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
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { mutations: { retry: false } },
          })
        }
      >
        <CompetitorAdsGrid data={data} />
      </QueryClientProvider>
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

  describe("triage tabs", () => {
    const triaged = [
      makeAd({ id: "ad1", archiveId: "a1", workflowStatus: "inbox" }),
      makeAd({ id: "ad2", archiveId: "a2", workflowStatus: "inbox" }),
      makeAd({ id: "ad3", archiveId: "a3", workflowStatus: "shortlist" }),
      makeAd({ id: "ad4", archiveId: "a4", workflowStatus: "deprioritised" }),
      makeAd({ id: "ad5", archiveId: "a5", workflowStatus: "made" }),
    ];

    it("counts every ad by tab and shows only the active tab's ads", async () => {
      const user = userEvent.setup();
      renderGrid(makeData(triaged));

      expect(screen.getByRole("button", { name: "All ads 2" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Shortlist 1" })).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Deprioritised 1" }),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Made ad 1" })).toBeVisible();

      // The inbox is the default landing tab.
      expect(screen.getByText("2 ads")).toBeVisible();

      await user.click(screen.getByRole("button", { name: "Shortlist 1" }));
      expect(screen.getByText("1 ad")).toBeVisible();
      expect(
        screen.getAllByRole("link", { name: /View in Ad Library/ }),
      ).toHaveLength(1);
    });

    it("keeps the format filter working inside a tab", () => {
      renderGrid(
        makeData([
          makeAd({ id: "ad1", workflowStatus: "shortlist" }),
          makeAd({
            id: "ad2",
            displayFormat: "VIDEO",
            workflowStatus: "shortlist",
          }),
          makeAd({ id: "ad3", displayFormat: "VIDEO", workflowStatus: "inbox" }),
        ]),
        "?status=shortlist&format=Video",
      );

      expect(screen.getByText("1 ad")).toBeVisible();
    });

    it("names the empty tab rather than blaming the filters", () => {
      renderGrid(makeData([makeAd({ workflowStatus: "inbox" })]), "?status=made");

      expect(
        screen.getByText(
          "No ads made yet — move shortlisted ads here with Make ad",
        ),
      ).toBeVisible();
    });

    it("shortlists the ticked ads from the inbox", async () => {
      const user = userEvent.setup();
      mutate.mockClear();
      renderGrid(makeData(triaged));

      await user.click(
        screen.getByRole("checkbox", { name: "Select ad a1" }),
      );
      await user.click(
        screen.getByRole("checkbox", { name: "Select ad a2" }),
      );

      expect(screen.getByText("2 selected")).toBeVisible();

      await user.click(
        screen.getByRole("button", { name: "Add to Shortlist" }),
      );

      expect(mutate).toHaveBeenCalledWith({
        adIds: ["ad1", "ad2"],
        status: "shortlist",
      });
    });

    it("deprioritises the ticked ads from the inbox", async () => {
      const user = userEvent.setup();
      mutate.mockClear();
      renderGrid(makeData(triaged));

      await user.click(screen.getByRole("checkbox", { name: "Select ad a2" }));
      await user.click(screen.getByRole("button", { name: "Deprioritise" }));

      expect(mutate).toHaveBeenCalledWith({
        adIds: ["ad2"],
        status: "deprioritised",
      });
    });

    it("moves a ticked shortlist ad to made", async () => {
      const user = userEvent.setup();
      mutate.mockClear();
      renderGrid(makeData(triaged), "?status=shortlist");

      await user.click(screen.getByRole("checkbox", { name: "Select ad a3" }));
      await user.click(screen.getByRole("button", { name: "Make ad" }));

      expect(mutate).toHaveBeenCalledWith({
        adIds: ["ad3"],
        status: "made",
      });
    });

    it("drops the selection when Clear is pressed", async () => {
      const user = userEvent.setup();
      renderGrid(makeData(triaged));

      await user.click(screen.getByRole("checkbox", { name: "Select ad a1" }));
      expect(screen.getByText("1 selected")).toBeVisible();

      await user.click(screen.getByRole("button", { name: "Clear" }));
      expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
    });

    it("offers no ticks on the archive tabs", () => {
      const { unmount } = renderGrid(
        makeData(triaged),
        "?status=deprioritised",
      );
      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
      unmount();

      renderGrid(makeData(triaged), "?status=made");
      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    });
  });
});
