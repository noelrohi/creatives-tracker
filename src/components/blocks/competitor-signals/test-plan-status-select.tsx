"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ImageIcon, Video } from "@/components/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTRPC } from "@/lib/trpc/client";
import { TEST_PLAN_FORMAT_LABELS } from "./display";
import type { TestPlanAd, TestPlanAdStatus } from "./types";

/**
 * The four steps plus the terminal veto (§9), in the order an ad walks them.
 * Plain labels, no colour: the steps are neutral bookkeeping, and colouring
 * them would only invent an urgency the data lacks.
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
 * The same control everywhere it appears, worn as a chip on a hook row: the
 * format icon carries which ad row is being moved, so the label never has to
 * repeat "Image"/"Video". The write settles inside the mutation, so the plan is
 * simply refetched on success.
 */
export function TestPlanFormatStatusSelect({
  ad,
}: {
  ad: Pick<TestPlanAd, "id" | "hook" | "format" | "status">;
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
  const formatLabel = TEST_PLAN_FORMAT_LABELS[ad.format] ?? ad.format;
  const FormatIcon = ad.format === "video" ? Video : ImageIcon;

  return (
    <Select
      value={ad.status}
      disabled={setStatus.isPending}
      onValueChange={(next) =>
        setStatus.mutate({ adId: ad.id, status: next as TestPlanAdStatus })
      }
    >
      <SelectTrigger
        size="sm"
        className="h-6 gap-1 rounded-full px-2 text-xs font-medium"
        aria-label={`${formatLabel} status — ${ad.hook}`}
      >
        <FormatIcon className="size-3.5 text-muted-foreground" />
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
