"use client";

import { type ReactNode, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldContent, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import { useTRPC } from "@/lib/trpc/client";
import {
  formatConversions,
  formatCurrency,
  formatRoas,
} from "./manager-ledger-format";
import type {
  ManagerAdRow,
  ManagerLedgerFilters,
  ManagerRowActions,
} from "./manager-ledger-types";

// Same bound as creative-ads-tab.tsx's rename form.
const renameAdSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(512, "Name must be 512 characters or fewer"),
});

type RenameAdForm = z.infer<typeof renameAdSchema>;

// The ad an action was invoked on plus the branch it hangs off. The branch ids
// are what we invalidate afterwards (§8) — a pause can re-prune a status-filtered
// tree, so the parent rollups have to refetch alongside the ad's own query.
export type ManagerAdActionTarget = {
  ad: ManagerAdRow;
  adSetId: string;
  campaignId: string;
};

export type ManagerAdActions = {
  forAd: (target: ManagerAdActionTarget) => ManagerRowActions | null;
};

// §8 actions live here rather than on the row so the two dialogs mount once for
// the whole ledger instead of once per ad, and so the ledger's rows stay
// presentational. `dialogs` is rendered by ManagerLedger outside the <table>.
export function useManagerAdActions(filters: ManagerLedgerFilters): {
  actions: ManagerAdActions;
  dialogs: ReactNode;
} {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Identical privilege check to the creatives page, which computes
  // `isReadOnly = role === "member"` and passes `canPauseMetaAds={!isReadOnly}`
  // (src/app/(protected)/creatives/[id]/page.tsx:82,:695).
  const { role } = useActiveOrganizationRole();
  const canPauseMetaAds = role !== "member";

  const [pauseTarget, setPauseTarget] = useState<ManagerAdActionTarget | null>(null);
  const [renameTarget, setRenameTarget] = useState<ManagerAdActionTarget | null>(null);

  const renameForm = useForm<RenameAdForm>({
    resolver: zodResolver(renameAdSchema),
    defaultValues: { name: "" },
  });

  // The ad's own query is keyed by its ad set, the ad set rollup by its
  // campaign; both reuse the page's current filters, so the keys are exact.
  // Campaigns also key on accountId, which lives on the page — invalidate that
  // level by prefix instead of reaching for the value.
  function invalidateBranch(target: ManagerAdActionTarget) {
    queryClient.invalidateQueries({
      queryKey: trpc.manager.ads.queryKey({ adSetId: target.adSetId, ...filters }),
    });
    queryClient.invalidateQueries({
      queryKey: trpc.manager.adSets.queryKey({
        campaignId: target.campaignId,
        ...filters,
      }),
    });
    queryClient.invalidateQueries({ queryKey: trpc.manager.campaigns.queryKey() });
  }

  // Result handling mirrors creative-ads-tab.tsx:131-156, narrowed to the single
  // ad this row acts on.
  const pauseMutation = useMutation(
    trpc.ad.pauseMetaAds.mutationOptions({
      onSuccess: (result) => {
        if (result.paused.length > 0) {
          toast.success("Paused ad in Meta");
        } else {
          toast.error("Ad was not paused", { description: result.failed[0]?.error });
        }

        if (pauseTarget) invalidateBranch(pauseTarget);
        setPauseTarget(null);
      },
      onError: (error) => toast.error(error.message || "Failed to pause ad"),
    }),
  );

  const renameMutation = useMutation(
    trpc.ad.renameMetaAd.mutationOptions({
      onSuccess: () => {
        toast.success("Ad renamed");
        if (renameTarget) invalidateBranch(renameTarget);
        setRenameTarget(null);
      },
      onError: (error) => toast.error(error.message || "Failed to rename ad"),
    }),
  );

  const pendingAdId = pauseMutation.isPending
    ? pauseTarget?.ad.id
    : renameMutation.isPending
      ? renameTarget?.ad.id
      : null;

  function forAd(target: ManagerAdActionTarget): ManagerRowActions | null {
    // Hidden, not disabled, without the privilege (§8). An ad with no Meta id
    // has nothing to write to either.
    if (!canPauseMetaAds || !target.ad.metaId) return null;

    return {
      // Pause only on active ads: `ad.pauseMetaAds` pauses and there is no
      // unpause procedure, so a play icon is not possible in v1.
      onPause:
        target.ad.status === "active" ? () => setPauseTarget(target) : undefined,
      onRename: () => {
        renameForm.reset({ name: target.ad.name });
        setRenameTarget(target);
      },
      isPending: pendingAdId === target.ad.id,
    };
  }

  function onRenameSubmit(values: RenameAdForm) {
    if (!renameTarget) return;
    renameMutation.mutate({ adId: renameTarget.ad.id, name: values.name });
  }

  const pausingAd = pauseTarget?.ad;

  const dialogs = (
    <>
      <Dialog
        open={!!pauseTarget}
        onOpenChange={(open) => !open && setPauseTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium">Pause this Meta ad?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              This will pause the ad in Meta and mark it as paused locally.
            </p>
            {pausingAd && (
              <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/20 p-2">
                <div className="min-w-0 px-1">
                  <div className="truncate font-medium text-foreground">
                    {pausingAd.name}
                  </div>
                  <div className="text-[11px]">{pausingAd.metaId}</div>
                </div>
                <div className="shrink-0 px-1 text-right text-[11px] tabular-nums">
                  <div>{formatCurrency(pausingAd.spend)}</div>
                  <div>
                    {formatRoas(pausingAd.roas)} ·{" "}
                    {formatConversions(pausingAd.conversions)} conv
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPauseTarget(null)}
              disabled={pauseMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={!pauseTarget || pauseMutation.isPending}
              onClick={() =>
                pauseTarget && pauseMutation.mutate({ adIds: [pauseTarget.ad.id] })
              }
            >
              {pauseMutation.isPending ? "Pausing..." : "Pause in Meta"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!renameTarget}
        onOpenChange={(open) => !open && setRenameTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium">Rename ad</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={renameForm.handleSubmit(onRenameSubmit)}
            className="grid gap-4"
          >
            <Field data-invalid={!!renameForm.formState.errors.name}>
              <FieldLabel htmlFor="manager-rename-ad-name">Name</FieldLabel>
              <FieldContent>
                <Input
                  id="manager-rename-ad-name"
                  {...renameForm.register("name")}
                  placeholder="Ad name"
                />
                <FieldError errors={[renameForm.formState.errors.name]} />
              </FieldContent>
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRenameTarget(null)}
                disabled={renameMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={renameMutation.isPending}>
                {renameMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );

  return { actions: { forAd }, dialogs };
}
