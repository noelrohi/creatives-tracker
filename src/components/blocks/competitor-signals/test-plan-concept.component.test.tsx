import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TestPlanConcept } from "./test-plan-concept";
import type { TestPlanAd, TestPlanConcept as Concept } from "./types";

const mutate = vi.fn();

// Every control on this card writes through one of four procedures; the client
// is stubbed to the shapes they reach for, and `mutate` records the payload.
vi.mock("@/lib/trpc/client", () => {
  const mutation = (name: string) => ({
    mutationOptions: (options: unknown) => ({
      ...(options as object),
      mutationKey: [name],
      mutationFn: (input: unknown) => {
        mutate(name, input);
        return Promise.resolve(null);
      },
    }),
  });

  return {
    useTRPC: () => ({
      signals: {
        testPlan: { queryKey: () => ["testPlan"] },
        planRules: { queryKey: () => ["planRules"] },
        setTestPlanAdStatus: mutation("setTestPlanAdStatus"),
        rateTestPlanHook: mutation("rateTestPlanHook"),
        addTestPlanComment: mutation("addTestPlanComment"),
        promoteCommentToRule: mutation("promoteCommentToRule"),
      },
    }),
  };
});

const HOOK_A = "The mouthguard your coach already wears";
const HOOK_B = "Your coach wore one first";

function makeAd(overrides: Partial<TestPlanAd> = {}): TestPlanAd {
  return {
    id: "ad1",
    hook: HOOK_A,
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
    hooks: [HOOK_A, HOOK_B],
    hookCopy: null,
    feedback: [],
    comments: [],
    generatedAt: new Date("2026-08-01T00:00:00Z"),
    ads: [
      makeAd({ id: "ad1", sortOrder: 0 }),
      makeAd({ id: "ad2", format: "video", status: "approved", sortOrder: 1 }),
      makeAd({ id: "ad3", hook: HOOK_B, status: "rejected", sortOrder: 2 }),
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

  it("counts the approved ad rows in the header", () => {
    renderConcept(makeConcept());

    expect(screen.getByText("1 of 3 approved")).toBeVisible();
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

  it("groups the ad rows under one row per hook, a status chip per format", () => {
    renderConcept(makeConcept());

    expect(screen.getByText(HOOK_A)).toBeVisible();
    expect(screen.getByText(HOOK_B)).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: `Image status — ${HOOK_A}` }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: `Video status — ${HOOK_A}` }),
    ).toBeVisible();
    // The second hook only ever survived as an image row: one chip, not two.
    expect(
      screen.getByRole("combobox", { name: `Image status — ${HOOK_B}` }),
    ).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: `Video status — ${HOOK_B}` }),
    ).toBeNull();
    expect(screen.getByText("Approved")).toBeVisible();
    expect(screen.getByText("Rejected")).toBeVisible();
  });

  it("renders the ad-copy strip for hooks the generator wrote copy for", () => {
    renderConcept(
      makeConcept({
        hookCopy: [
          {
            hook: HOOK_A,
            headline: "Coaches wear it first",
            description: "The mouthguard on the sideline, not just the shelf",
            cta: "Shop now",
          },
        ],
      }),
    );

    expect(screen.getByText("Coaches wear it first")).toBeVisible();
    expect(
      screen.getByText("The mouthguard on the sideline, not just the shelf"),
    ).toBeVisible();
    expect(screen.getByText("Shop now")).toBeVisible();
  });

  it("omits the copy strip entirely on a plan that predates hook copy", () => {
    renderConcept(makeConcept({ hookCopy: null }));

    expect(screen.queryByText("Shop now")).toBeNull();
    expect(screen.getByText(HOOK_A)).toBeVisible();
  });

  it("keeps the reason panel away from a hook that was rated up", () => {
    renderConcept(
      makeConcept({
        feedback: [{ hook: HOOK_A, rating: "up", reasons: [] }],
      }),
    );

    expect(screen.queryByText("What's off?")).toBeNull();

    // Ratings are the one place on this card that carries colour — the
    // uncoloured rule covers the status steps, not the thumbs.
    const up = screen.getByRole("button", { name: `Useful — ${HOOK_A}` });
    expect(up).toHaveAttribute("aria-pressed", "true");
    expect(up).toHaveClass(
      "text-[var(--attr-good)]",
      "bg-[var(--attr-good-soft)]",
    );
    expect(
      screen.getByRole("button", { name: `Not useful — ${HOOK_A}` }),
    ).not.toHaveClass("text-[var(--attr-critical)]");
  });

  it("reveals the reason chips under a thumbs-down hook, lit as stored", () => {
    renderConcept(
      makeConcept({
        feedback: [{ hook: HOOK_A, rating: "down", reasons: ["too_generic"] }],
      }),
    );

    expect(screen.getByText("What's off?")).toBeVisible();
    expect(
      screen.getByRole("button", { name: `Not useful — ${HOOK_A}` }),
    ).toHaveClass(
      "text-[var(--attr-critical)]",
      "bg-[var(--attr-critical-soft)]",
    );

    const picked = screen.getByRole("button", { name: "Too generic" });
    expect(picked).toHaveAttribute("aria-pressed", "true");
    expect(picked).toHaveClass(
      "border-[var(--attr-critical)]/45",
      "bg-[var(--attr-critical-soft)]",
    );

    const unpicked = screen.getByRole("button", { name: "Weak CTA" });
    expect(unpicked).toHaveAttribute("aria-pressed", "false");
    expect(unpicked).not.toHaveClass("bg-[var(--attr-critical-soft)]");
  });

  it("sends the reason slug, not its label, when a chip is picked", async () => {
    mutate.mockClear();
    renderConcept(
      makeConcept({
        feedback: [{ hook: HOOK_A, rating: "down", reasons: [] }],
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Weak CTA" }));

    expect(mutate).toHaveBeenCalledWith("rateTestPlanHook", {
      conceptId: "cp1",
      hook: HOOK_A,
      rating: "down",
      reasons: ["weak_cta"],
    });
  });

  it("renders the app-owned budget-routing boilerplate on the card", () => {
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
    expect(screen.getByText(/never these evidence scores/)).toBeVisible();
  });

  it("collapses the guardrail behind its toggle, closed to start", async () => {
    renderConcept(makeConcept());

    expect(screen.getByText("Copy guardrail")).toBeVisible();
    expect(
      screen.queryByText(/Never promise a performance gain in numbers/),
    ).toBeNull();

    await userEvent.click(screen.getByText("Copy guardrail"));

    expect(
      screen.getByText(/Never promise a performance gain in numbers/),
    ).toBeVisible();
  });

  it("renders the thread and offers to promote a comment that is not a rule", () => {
    renderConcept(
      makeConcept({
        comments: [
          {
            id: "cm1",
            authorName: "Mara Kent",
            createdAt: new Date(),
            text: "Lead with the partner angle next time",
            promotedRuleId: null,
          },
        ],
      }),
    );

    expect(screen.getByText("Feedback")).toBeVisible();
    expect(screen.getByText("Read by the next plan run.")).toBeVisible();
    expect(screen.getByText("MK")).toBeVisible();
    expect(screen.getByText("Mara Kent")).toBeVisible();
    expect(
      screen.getByText("Lead with the partner angle next time"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Make this a rule" }),
    ).toBeVisible();
  });

  it("swaps the promote button for the rule tag once a comment is promoted", () => {
    renderConcept(
      makeConcept({
        comments: [
          {
            id: "cm1",
            authorName: "Mara Kent",
            createdAt: new Date(),
            text: "Lead with the partner angle next time",
            promotedRuleId: "rule1",
          },
        ],
      }),
    );

    expect(
      screen.getByText("Plan rule — applies to every future generation"),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Make this a rule" })).toBeNull();
  });

  it("keeps the composer's post button dead until something is typed", async () => {
    mutate.mockClear();
    renderConcept(makeConcept());

    const post = screen.getByRole("button", { name: "Post feedback" });
    expect(post).toBeDisabled();

    await userEvent.type(
      screen.getByRole("textbox", { name: /Feedback on Coaches vouch first/ }),
      "Try a partner angle",
    );
    expect(post).toBeEnabled();

    await userEvent.click(post);
    expect(mutate).toHaveBeenCalledWith("addTestPlanComment", {
      conceptId: "cp1",
      text: "Try a partner angle",
    });
  });
});
