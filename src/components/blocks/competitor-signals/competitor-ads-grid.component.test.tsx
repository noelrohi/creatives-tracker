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

// Radix Select drives its listbox with pointer-capture and scrolling APIs
// jsdom doesn't implement; stub them so tests can open the filter selects.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

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

    it("counts every ad by tab and defaults All ads to untriaged", async () => {
      const user = userEvent.setup();
      renderGrid(makeData(triaged));

      // The tab count covers the complete active set, while its default filter
      // hides ads that have already moved through the workflow.
      expect(screen.getByRole("button", { name: "All ads 5" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Shortlist 1" })).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Deprioritised 1" }),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Made ad 1" })).toBeVisible();
      expect(
        screen.getByRole("combobox", { name: "Status filter" }),
      ).toHaveTextContent("Untriaged");
      expect(screen.getByText("2 ads")).toBeVisible();
      expect(
        screen.getAllByRole("link", { name: /View in Ad Library/ }),
      ).toHaveLength(2);

      await user.click(screen.getByRole("button", { name: "Shortlist 1" }));
      expect(screen.getByText("1 ad")).toBeVisible();
      expect(
        screen.getAllByRole("link", { name: /View in Ad Library/ }),
      ).toHaveLength(1);
    });

    it.each([
      ["shortlist", "Shortlist"],
      ["deprioritised", "Deprioritised"],
      ["made", "Made ad"],
    ])("can filter All ads to %s", (workflow, stageLabel) => {
      renderGrid(makeData(triaged), `?workflow=${workflow}`);

      expect(screen.getByText("1 ad")).toBeVisible();
      expect(
        screen.getByText(stageLabel, { selector: "span.absolute" }),
      ).toBeVisible();
    });

    it("composes status, format, and theme filters in All ads", () => {
      renderGrid(
        makeData([
          makeAd({
            id: "ad1",
            archiveId: "a1",
            displayFormat: "VIDEO",
            theme: "Sleep science",
            workflowStatus: "shortlist",
          }),
          makeAd({
            id: "ad2",
            archiveId: "a2",
            displayFormat: "IMAGE",
            theme: "Sleep science",
            workflowStatus: "shortlist",
          }),
          makeAd({
            id: "ad3",
            archiveId: "a3",
            displayFormat: "VIDEO",
            theme: "Coach endorsement",
            workflowStatus: "shortlist",
          }),
        ]),
        "?workflow=shortlist&format=Video&theme=Sleep%20science",
      );

      expect(screen.getByText("1 ad")).toBeVisible();
      expect(
        screen.getAllByRole("link", { name: /View in Ad Library/ }),
      ).toHaveLength(1);
    });

    it("names an empty default view when every ad is triaged", () => {
      renderGrid(makeData([makeAd({ workflowStatus: "made" })]));

      expect(screen.getByText("No untriaged ads")).toBeVisible();
    });

    it("can show every status again in All ads", () => {
      renderGrid(makeData(triaged), "?workflow=all");

      expect(screen.getByText("5 ads")).toBeVisible();
      expect(
        screen.getAllByRole("link", { name: /View in Ad Library/ }),
      ).toHaveLength(5);
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
          makeAd({
            id: "ad3",
            displayFormat: "VIDEO",
            workflowStatus: "inbox",
          }),
        ]),
        "?status=shortlist&format=Video",
      );

      expect(screen.getByText("1 ad")).toBeVisible();
    });

    it("names the empty tab rather than blaming the filters", () => {
      renderGrid(
        makeData([makeAd({ workflowStatus: "inbox" })]),
        "?status=made",
      );

      expect(
        screen.getByText(
          "No ads made yet — move shortlisted ads here with Make ad",
        ),
      ).toBeVisible();
    });

    it("marks moved ads with their stage on All ads only", async () => {
      const user = userEvent.setup();
      renderGrid(makeData(triaged), "?workflow=all");

      // The pile shows where each moved ad went; untouched ads wear nothing.
      // Scoped to span so the tab buttons' own labels don't match.
      const chip = { selector: "span" };
      expect(screen.getByText("Shortlist", chip)).toBeVisible();
      expect(screen.getByText("Deprioritised", chip)).toBeVisible();
      expect(screen.getByText("Made ad", chip)).toBeVisible();

      // The stage tab itself doesn't repeat what the tab already says.
      await user.click(screen.getByRole("button", { name: "Shortlist 1" }));
      expect(screen.queryByText("Shortlist", chip)).not.toBeInTheDocument();
    });

    it("blames the filters when they hide a tab that does have ads", () => {
      renderGrid(
        makeData([makeAd({ workflowStatus: "shortlist" })]),
        "?status=shortlist&format=Video",
      );

      expect(screen.getByText("No ads match these filters")).toBeVisible();
      expect(
        screen.queryByText(
          "Nothing shortlisted yet — tick ads under All ads and add them here",
        ),
      ).not.toBeInTheDocument();
    });

    it("shortlists the ticked ads from the inbox", async () => {
      const user = userEvent.setup();
      mutate.mockClear();
      renderGrid(makeData(triaged));

      await user.click(screen.getByRole("checkbox", { name: "Select ad a1" }));
      await user.click(screen.getByRole("checkbox", { name: "Select ad a2" }));

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

    it("offers ticks only on untouched ads within All ads", () => {
      renderGrid(makeData(triaged));

      // Two inbox ads are tickable; the three already-triaged ads are not.
      expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    });

    it("drops ticks from the bar when a filter hides their ads", async () => {
      const user = userEvent.setup();
      renderGrid(
        makeData([
          makeAd({ id: "ad1", archiveId: "a1" }),
          makeAd({ id: "ad2", archiveId: "a2", displayFormat: "VIDEO" }),
        ]),
      );

      await user.click(screen.getByRole("checkbox", { name: "Select ad a1" }));
      expect(screen.getByText("1 selected")).toBeVisible();

      // The format filter hides the ticked image ad — the bar must not keep
      // offering to move it.
      await user.click(screen.getByRole("combobox", { name: "Format filter" }));
      await user.click(screen.getByRole("option", { name: "Video" }));
      expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
    });

    it.each([
      ["shortlist", "a3"],
      ["deprioritised", "a4"],
      ["made", "a5"],
    ])("moves a %s ad back to All ads", async (tab, archiveId) => {
      const user = userEvent.setup();
      mutate.mockClear();
      renderGrid(makeData(triaged), `?status=${tab}`);

      await user.click(
        screen.getByRole("checkbox", { name: `Select ad ${archiveId}` }),
      );
      await user.click(screen.getByRole("button", { name: "Move to All ads" }));

      expect(mutate).toHaveBeenCalledWith({
        adIds: [`ad${archiveId.slice(1)}`],
        status: "inbox",
      });
    });
  });
});
