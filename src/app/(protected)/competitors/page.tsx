"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useBreadcrumbs } from "@/components/breadcrumbs";
import { AddCompetitorDialog } from "@/components/blocks/competitor-signals/add-competitor-dialog";
import { CompetitorCard } from "@/components/blocks/competitor-signals/competitor-card";
import { NO_COMPETITORS_NOTE } from "@/components/blocks/competitor-signals/copy";
import { Plus, Radar } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTRPC } from "@/lib/trpc/client";

export default function CompetitorsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);

  useBreadcrumbs([{ label: "Competitors" }]);

  const competitors = useQuery(trpc.signals.listCompetitors.queryOptions());

  const archiveMutation = useMutation(
    trpc.signals.archiveCompetitor.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.signals.listCompetitors.queryKey(),
        });
        toast.success("Competitor archived");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const items = competitors.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Competitors</h1>
          <p className="text-sm text-muted-foreground">
            Public Meta Ad Library activity per tracked competitor.
          </p>
        </div>
        {items.length > 0 && (
          <Button
            size="sm"
            onClick={() => setDialogOpen(true)}
            className="gap-1.5"
          >
            <Plus className="size-3.5" /> Add competitor
          </Button>
        )}
      </div>

      {competitors.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-16">
          <Radar className="size-8 text-muted-foreground/40" />
          <div className="text-center">
            <p className="text-sm text-muted-foreground">
              No competitors tracked yet
            </p>
            <p className="text-[13px] text-muted-foreground/40">
              {NO_COMPETITORS_NOTE}.
            </p>
          </div>
          <Button size="sm" onClick={() => setDialogOpen(true)} className="gap-1.5">
            <Plus className="size-3.5" /> Add competitor
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((competitor) => (
            <CompetitorCard
              key={competitor.id}
              competitor={competitor}
              archiveDisabled={archiveMutation.isPending}
              onArchive={(competitorId) =>
                archiveMutation.mutate({ competitorId })
              }
            />
          ))}
        </div>
      )}

      <AddCompetitorDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
