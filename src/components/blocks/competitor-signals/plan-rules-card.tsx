"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { toast } from "sonner";
import { Shield } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { BUILT_IN_PLAN_RULE } from "@/lib/competitor-signals/plan-feedback";
import { useTRPC } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import type { PlanRule } from "./types";

/** "Promoted from feedback · Mara K. · 2 days ago" / "Added by …". */
function attribution(rule: PlanRule): string {
  const verb =
    rule.source === "feedback"
      ? `Promoted from feedback · ${rule.attributionName}`
      : `Added by ${rule.attributionName}`;
  return `${verb} · ${formatDistanceToNow(rule.createdAt, { addSuffix: true })}`;
}

function RuleRow({ rule }: { rule: PlanRule }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const setActive = useMutation(
    trpc.signals.setPlanRuleActive.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.signals.planRules.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  return (
    <div className="flex items-start gap-3 border-t px-5 py-3">
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-[13px] leading-relaxed",
            !rule.active && "text-muted-foreground",
          )}
        >
          {rule.text}
        </p>
        <p className="text-xs text-muted-foreground">{attribution(rule)}</p>
      </div>
      <Switch
        className="mt-0.5"
        checked={rule.active}
        disabled={setActive.isPending}
        aria-label={`Rule active — ${rule.text}`}
        onCheckedChange={(active) =>
          setActive.mutate({ ruleId: rule.id, active })
        }
      />
    </div>
  );
}

/**
 * The org's standing instructions. The compliance guardrail is pinned first
 * and carries no switch: it is a code fixture the harness repeats verbatim
 * (see `BUILT_IN_PLAN_RULE`), so there is nothing here to turn off.
 */
export function PlanRulesCard({ rules }: { rules: PlanRule[] }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");

  const addRule = useMutation(
    trpc.signals.addPlanRule.mutationOptions({
      onSuccess: () => {
        setDraft("");
        queryClient.invalidateQueries({
          queryKey: trpc.signals.planRules.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardContent className="px-5 pt-4 pb-3.5">
        <p className="text-sm font-semibold">Plan rules</p>
        <p className="text-[13px] text-muted-foreground">
          Standing instructions every plan generation follows. Rules stack with
          each concept&apos;s copy guardrail.
        </p>
      </CardContent>

      <div className="flex items-start gap-3 border-t px-5 py-3">
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed">
          {BUILT_IN_PLAN_RULE}
        </p>
        <Badge variant="outline" className="mt-0.5 shrink-0 font-medium">
          <Shield className="size-3" />
          Built-in
        </Badge>
      </div>

      {rules.map((rule) => (
        <RuleRow key={rule.id} rule={rule} />
      ))}

      <div className="flex gap-2 border-t bg-muted/20 px-5 py-3.5">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={addRule.isPending}
          aria-label="New plan rule"
          placeholder="Add a rule for every future plan…"
          className="h-7 text-[13px]"
        />
        <Button
          size="sm"
          disabled={draft.trim().length === 0 || addRule.isPending}
          onClick={() => addRule.mutate({ text: draft.trim() })}
        >
          Add rule
        </Button>
      </div>
    </Card>
  );
}
