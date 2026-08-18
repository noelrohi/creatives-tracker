import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PlanRulesCard } from "./plan-rules-card";
import type { PlanRule } from "./types";

const mutate = vi.fn();

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
        planRules: { queryKey: () => ["planRules"] },
        addPlanRule: mutation("addPlanRule"),
        setPlanRuleActive: mutation("setPlanRuleActive"),
      },
    }),
  };
});

function makeRule(overrides: Partial<PlanRule> = {}): PlanRule {
  return {
    id: "r1",
    text: "Always include at least one partner-angle hook",
    source: "feedback",
    active: true,
    attributionName: "Mara Kent",
    createdAt: new Date(),
    ...overrides,
  };
}

function renderCard(rules: PlanRule[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <PlanRulesCard rules={rules} />
    </QueryClientProvider>,
  );
}

describe("PlanRulesCard", () => {
  it("pins the built-in guardrail first and gives it no switch", () => {
    renderCard([makeRule()]);

    expect(screen.getByText("Plan rules")).toBeVisible();
    expect(
      screen.getByText(/Standing instructions every plan generation follows/),
    ).toBeVisible();

    const builtIn = screen.getByText(
      /Never claim to diagnose, treat, or cure a condition/,
    );
    expect(builtIn).toBeVisible();
    expect(screen.getByText("Built-in")).toBeVisible();

    // One rule, one switch: the fixture carries none.
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(builtIn.compareDocumentPosition(screen.getByText(/partner-angle/))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("attributes a rule to where it came from", () => {
    renderCard([
      makeRule(),
      makeRule({
        id: "r2",
        source: "manual",
        text: "Plain, direct voice — no rhetorical questions",
        attributionName: "Noel Rohi",
      }),
    ]);

    expect(
      screen.getByText(/Promoted from feedback · Mara Kent · /),
    ).toBeVisible();
    expect(screen.getByText(/Added by Noel Rohi · /)).toBeVisible();
  });

  it("dims an inactive rule but keeps it switchable back on", async () => {
    mutate.mockClear();
    renderCard([makeRule({ active: false })]);

    expect(screen.getByText(/partner-angle/)).toHaveClass("text-muted-foreground");

    const toggle = screen.getByRole("switch");
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);
    expect(mutate).toHaveBeenCalledWith("setPlanRuleActive", {
      ruleId: "r1",
      active: true,
    });
  });

  it("turns an active rule off through the same switch", async () => {
    mutate.mockClear();
    renderCard([makeRule()]);

    await userEvent.click(screen.getByRole("switch"));
    expect(mutate).toHaveBeenCalledWith("setPlanRuleActive", {
      ruleId: "r1",
      active: false,
    });
  });

  it("keeps the composer dead until a rule is typed", async () => {
    mutate.mockClear();
    renderCard([]);

    const add = screen.getByRole("button", { name: "Add rule" });
    expect(add).toBeDisabled();

    await userEvent.type(
      screen.getByRole("textbox", { name: "New plan rule" }),
      "Never open on a question",
    );
    expect(add).toBeEnabled();

    await userEvent.click(add);
    expect(mutate).toHaveBeenCalledWith("addPlanRule", {
      text: "Never open on a question",
    });
  });
});
