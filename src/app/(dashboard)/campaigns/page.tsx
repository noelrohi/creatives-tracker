"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemMedia,
  ItemGroup,
  ItemActions,
} from "@/components/ui/item";
import { Plus, Megaphone, Trash2, CheckSquare } from "lucide-react";
import { toast } from "sonner";
import { CampaignFormDialog } from "./campaign-form-dialog";

export default function CampaignsPage() {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const campaigns = useQuery(trpc.campaignConfig.list.queryOptions());
  const [createOpen, setCreateOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);

  const deleteMutation = useMutation({
    ...trpc.campaignConfig.delete.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.campaignConfig.list.queryKey() });
    },
  });

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (!campaigns.data) return;
    if (selected.size === campaigns.data.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(campaigns.data.map((c) => c.id)));
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selected);
    await Promise.all(ids.map((id) => deleteMutation.mutateAsync({ id })));
    toast.success(`${ids.length} campaign${ids.length > 1 ? "s" : ""} deleted`);
    setSelected(new Set());
    setSelecting(false);
    setDeleteOpen(false);
  };

  const exitSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-medium tracking-tight">Campaigns</h1>
        {campaigns.data ? (
          <span className="text-[13px] tabular-nums text-muted-foreground/50">
            {campaigns.data.length}
          </span>
        ) : null}
        <div className="flex-1" />
        {campaigns.data && campaigns.data.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={selecting ? exitSelecting : () => setSelecting(true)}
            className="gap-1.5 text-muted-foreground"
          >
            <CheckSquare className="size-3.5" />
            {selecting ? "Cancel" : "Select"}
          </Button>
        )}
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          className="gap-1.5"
        >
          <Plus className="size-3.5" />
          New
        </Button>
      </div>

      {campaigns.isLoading ? (
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
              <Skeleton className="size-8 rounded-md" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-5 w-20 rounded" />
            </div>
          ))}
        </div>
      ) : campaigns.data?.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-20">
          <div className="flex size-12 items-center justify-center rounded-full bg-amber-500/10">
            <Megaphone className="size-5 text-amber-500/50" />
          </div>
          <div className="text-center">
            <p className="text-sm text-muted-foreground">No campaigns yet</p>
            <p className="text-[13px] text-muted-foreground/40">
              Configure your media buying setups.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="mr-1.5 size-3.5" /> Create Campaign
          </Button>
        </div>
      ) : (
        <>
          {selecting && campaigns.data && campaigns.data.length > 0 && (
            <div className="flex items-center gap-3 px-3 py-1.5">
              <Checkbox
                checked={selected.size === campaigns.data.length && campaigns.data.length > 0}
                onCheckedChange={toggleAll}
              />
              <span className="text-xs text-muted-foreground">
                {selected.size === 0
                  ? "Select all"
                  : `${selected.size} of ${campaigns.data.length} selected`}
              </span>
            </div>
          )}
          <ItemGroup>
            {campaigns.data?.map((campaign) => (
              <Item
                key={campaign.id}
                asChild
                variant="outline"
                size="sm"
                className={selecting && selected.has(campaign.id) ? "bg-muted/60" : ""}
              >
                {selecting ? (
                  <div
                    className="hover:bg-muted/40 transition-colors cursor-pointer"
                    onClick={() => toggleSelect(campaign.id)}
                  >
                    <Checkbox
                      checked={selected.has(campaign.id)}
                      onCheckedChange={() => toggleSelect(campaign.id)}
                      onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      className="self-center"
                    />
                    <ItemMedia variant="icon">
                      <div className="flex size-8 items-center justify-center rounded-md bg-amber-500/10">
                        <Megaphone className="size-3.5 text-amber-500" />
                      </div>
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{campaign.name}</ItemTitle>
                      <ItemDescription>
                        {[
                          campaign.objective?.replace(/_/g, " "),
                          campaign.dailyBudget ? `$${campaign.dailyBudget}/day` : null,
                          campaign.geos?.length ? campaign.geos.join(", ") : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "No details yet"}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {campaign.objective ? (
                        <Badge
                          variant="secondary"
                          className="h-5 rounded px-1.5 text-[11px] font-normal capitalize"
                        >
                          {campaign.objective.replace(/_/g, " ")}
                        </Badge>
                      ) : null}
                    </ItemActions>
                  </div>
                ) : (
                  <Link
                    href={`/campaigns/${campaign.id}`}
                    className="hover:bg-muted/40 transition-colors"
                  >
                    <ItemMedia variant="icon">
                      <div className="flex size-8 items-center justify-center rounded-md bg-amber-500/10">
                        <Megaphone className="size-3.5 text-amber-500" />
                      </div>
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{campaign.name}</ItemTitle>
                      <ItemDescription>
                        {[
                          campaign.objective?.replace(/_/g, " "),
                          campaign.dailyBudget ? `$${campaign.dailyBudget}/day` : null,
                          campaign.geos?.length ? campaign.geos.join(", ") : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "No details yet"}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {campaign.objective ? (
                        <Badge
                          variant="secondary"
                          className="h-5 rounded px-1.5 text-[11px] font-normal capitalize"
                        >
                          {campaign.objective.replace(/_/g, " ")}
                        </Badge>
                      ) : null}
                    </ItemActions>
                  </Link>
                )}
              </Item>
            ))}
          </ItemGroup>
        </>
      )}

      {selected.size > 0 && (
        <div className="sticky bottom-4 z-10 mx-auto flex items-center gap-3 rounded-lg border bg-background px-4 py-2.5 shadow-lg">
          <span className="text-sm font-medium tabular-nums">
            {selected.size} selected
          </span>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setDeleteOpen(true)}
            className="gap-1.5"
          >
            <Trash2 className="size-3.5" />
            Delete
          </Button>
        </div>
      )}

      <CampaignFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={(id) => router.push(`/campaigns/${id}`)}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${selected.size} campaign${selected.size > 1 ? "s" : ""}`}
        description="This will permanently delete the selected campaigns. This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={handleBulkDelete}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
