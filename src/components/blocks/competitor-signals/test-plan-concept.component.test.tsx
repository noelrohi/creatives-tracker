import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TestPlanConcept } from "./test-plan-concept";
import type { TestPlanAd, TestPlanConcept as Concept } from "./types";

// The status control is the only part of this tree that talks to the server;
// the checklist itself is pure rendering, so the client is stubbed to the two
// shapes the control reaches for.
vi.mock("@/lib/trpc/client", () => ({
  useTRPC: () => ({
    signals: {
      testPlan: { queryKey: () => ["testPlan"] },
      setTestPlanAdStatus: {
        mutationOptions: (options: unknown) => ({
          ...(options as object),
          mutationKey: ["setTestPlanAdStatus"],
          mutationFn: () => Promise.resolve(null),
        }),
      },
    },
  }),
}));

function makeAd(overrides: Partial<TestPlanAd> = {}): TestPlanAd {
  return {
    id: "ad1",
    hook: "The mouthguard your coach already wears",
    format: "static",
    status: "proposed",
    sortOrder: 0,
    ...overrides,
  };
}

function makeConcept(overrides: Partial<Concept> = {}): Concept {
  return {
    id: "cp1",
    title: "Coaches vouch first",
    angle: "social_proof",
    audience: "Strength athletes who already train with a coach",
    evidenceClusterIds: ["cl1", "cl2"],
    evidenceCitation:
      "Coach endorsement (AIRWAAV, score 70) — 7 ads, live 105 days",
    measurementPlan: "Read CTR at 3 days, CAC at 7 days against the control set",
    claimGuardrail: "Never promise a performance gain in numbers",
    hooks: ["The mouthguard your coach already wears"],
    generatedAt: new Date("2026-08-01T00:00:00Z"),
    ads: [
      makeAd({ id: "ad1", sortOrder: 0 }),
      makeAd({ id: "ad2", hook: "Your coach wore one first", format: "video", status: "approved", sortOrder: 1 }),
      makeAd({ id: "ad3", hook: "What the bench never told you", format: "static", status: "rejected", sortOrder: 2 }),
    ],
    inspiration: null,
    ...overrides,
  };
}

function renderConcept(concept: Concept) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <TestPlanConcept concept={concept} />
    </QueryClientProvider>,
  );
}

describe("TestPlanConcept", () => {
  it("heads the concept with its humanized angle and its evidence", () => {
    renderConcept(makeConcept());

    expect(screen.getByText("Coaches vouch first")).toBeVisible();
    expect(screen.getByText("Social proof")).toBeVisible();
    expect(screen.getByText("Why this test")).toBeVisible();
    expect(
      screen.getByText("Strength athletes who already train with a coach"),
    ).toBeVisible();
    expect(
      screen.getByText(/Coach endorsement \(AIRWAAV, score 70\)/),
    ).toBeVisible();
    expect(screen.getByText(/Read CTR at 3 days/)).toBeVisible();
  });

  it("shows the competitor ads a concept was written from when they resolve", () => {
    renderConcept(
      makeConcept({
        inspiration: {
          clusterLabel: "Coach endorsement",
          competitorId: "c1",
          competitorName: "AIRWAAV",
          metaPageId: "123456789",
          adCount: 7,
          oldestStartDate: null,
          previewAds: [
            {
              archiveId: "a1",
              thumbnailUrl: "https://blob.test/a1.jpg",
              isVideo: false,
              videoUrl: null,
            },
          ],
        },
      }),
    );

    expect(screen.getByText("Inspired by 7 AIRWAAV ads")).toBeVisible();
    expect(
      screen.getByRole("link", { name: /View in Ad Library/ }),
    ).toHaveAttribute(
      "href",
      "https://www.facebook.com/ads/library/?view_all_page_id=123456789",
    );
  });

  it("hides the inspiration strip when the evidence clusters no longer resolve", () => {
    renderConcept(makeConcept({ inspiration: null }));

    expect(screen.queryByText(/Inspired by/)).toBeNull();
  });

  it("renders one row per ad, each with its format and its status", () => {
    renderConcept(makeConcept());

    expect(screen.getAllByRole("row")).toHaveLength(4); // header + 3 ads
    expect(
      screen.getByText("The mouthguard your coach already wears"),
    ).toBeVisible();
    expect(screen.getByText("Your coach wore one first")).toBeVisible();
    expect(screen.getByText("What the bench never told you")).toBeVisible();
    expect(screen.getAllByText("Image")).toHaveLength(2);
    expect(screen.getByText("Video")).toBeVisible();
    expect(screen.getByText("Proposed")).toBeVisible();
    expect(screen.getByText("Approved")).toBeVisible();
    expect(screen.getByText("Rejected")).toBeVisible();
  });

  it("renders the app-owned budget-routing boilerplate on the header", () => {
    renderConcept(makeConcept());

    expect(
      screen.getByText(
        /Scale and kill decisions follow measured CTR, CAC, and ROAS in Adsolute/,
      ),
    ).toBeVisible();
  });

  it("keeps the boilerplate even on a concept carrying no guardrail", () => {
    renderConcept(makeConcept({ claimGuardrail: null }));

    expect(screen.queryByText("Copy guardrail")).toBeNull();
    expect(
      screen.getByText(/never these evidence scores/),
    ).toBeVisible();
  });

  it("marks the guardrail as a constraint when the generator returned one", () => {
    renderConcept(makeConcept());

    expect(screen.getByText("Copy guardrail")).toBeVisible();
    expect(
      screen.getByText(/Never promise a performance gain in numbers/),
    ).toBeVisible();
  });
});
