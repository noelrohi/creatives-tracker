"use client";

import { useQuery } from "@tanstack/react-query";
import { NO_TEST_PLAN_NOTE } from "@/components/blocks/competitor-signals/copy";
import { EvidenceBanner } from "@/components/blocks/competitor-signals/evidence-banner";
import { PlanRulesCard } from "@/components/blocks/competitor-signals/plan-rules-card";
import { TestPlanConcept } from "@/components/blocks/competitor-signals/test-plan-concept";
import { useBreadcrumbs } from "@/components/breadcrumbs";
import { Target } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { useTRPC } from "@/lib/trpc/client";

export default function TestPlanPage() {
  const trpc = useTRPC();

  useBreadcrumbs([
    { label: "Competitors", href: "/competitors" },
    { label: "Test plan" },
  ]);

  const plan = useQuery(trpc.signals.testPlan.queryOptions());
  const rules = useQuery(trpc.signals.planRules.queryOptions());

  // Concepts and their ads arrive ordered by the router; the screen never
  // re-sorts them.
  const concepts = plan.data?.concepts ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Test plan</h1>
        <p className="text-sm text-muted-foreground">
          Ad ideas drawn from the strongest signals.
        </p>
      </div>

      <EvidenceBanner />

      {plan.isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : concepts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-16">
          <Target className="size-8 text-muted-foreground/40" />
          <div className="text-center">
            <p className="text-sm text-muted-foreground">{NO_TEST_PLAN_NOTE}</p>
            <p className="text-[13px] text-muted-foreground/40">
              Plans are generated on the operator device — there is nothing to
              press here.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {concepts.map((concept) => (
            <TestPlanConcept key={concept.id} concept={concept} />
          ))}
        </div>
      )}

      {/* Rules outlive any one plan, so the card stands even before a plan
       * has ever been pushed. */}
      {rules.isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (
        <PlanRulesCard rules={rules.data?.rules ?? []} />
      )}
    </div>
  );
}
