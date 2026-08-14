"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTRPC } from "@/lib/trpc/client";
import type { TestPlanAdStatus } from "./types";

/**
 * The four steps plus the terminal veto (§9), in the order an ad walks them.
 * Status is carried by its label alone — the checklist is a tracking sheet, and
 * colouring five neutral steps would only invent an urgency the data lacks.
 */
const STATUS_ORDER = [
  "proposed",
  "approved",
  "testing",
  "done",
  "rejected",
] as const;

const STATUS_LABELS: Record<(typeof STATUS_ORDER)[number], string> = {
  proposed: "Proposed",
  approved: "Approved",
  testing: "Testing",
  done: "Done",
  rejected: "Rejected",
};

/**
 * The only mutable thing on the screen: one ad's status, moved by any org
 * member. The write settles inside the mutation, so the plan is simply
 * refetched on success.
 */
export function TestPlanStatusSelect({
  adId,
  hook,
  status,
}: {
  adId: string;
  hook: string;
  status: TestPlanAdStatus;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const setStatus = useMutation(
    trpc.signals.setTestPlanAdStatus.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.signals.testPlan.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  return (
    <Select
      value={status}
      disabled={setStatus.isPending}
      onValueChange={(next) =>
        setStatus.mutate({ adId, status: next as TestPlanAdStatus })
      }
    >
      <SelectTrigger size="sm" className="w-28" aria-label={`Status — ${hook}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUS_ORDER.map((value) => (
          <SelectItem key={value} value={value}>
            {STATUS_LABELS[value]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
