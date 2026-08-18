"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { EvidenceBanner } from "@/components/blocks/competitor-signals/evidence-banner";
import { EvidencePanel } from "@/components/blocks/competitor-signals/evidence-panel";
import { NO_CLUSTERS_NOTE } from "@/components/blocks/competitor-signals/copy";
import { SignalsLedger } from "@/components/blocks/competitor-signals/signals-ledger";
import { useBreadcrumbs } from "@/components/breadcrumbs";
import { Radar } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTRPC } from "@/lib/trpc/client";

export default function SignalsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useBreadcrumbs([
    { label: "Competitors", href: "/competitors" },
    { label: "Signals" },
  ]);

  const ranked = useQuery(trpc.signals.rankedSignals.queryOptions());

  // Re-score is the only action on this screen (§10): a pure recompute over
  // stored inputs, so it finishes inside the mutation — nothing to subscribe to.
  const rescoreMutation = useMutation(
    trpc.signals.rescore.mutationOptions({
      onSuccess: (result) => {
        queryClient.invalidateQueries({
          queryKey: trpc.signals.rankedSignals.queryKey(),
        });
        toast.success(
          `Rescored ${result.clustersRescored} ${
            result.clustersRescored === 1 ? "cluster" : "clusters"
          }`,
        );
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const signals = ranked.data?.signals ?? [];
  // The selection survives a refetch when the cluster is still ranked, and
  // falls back to the top of the ledger when it isn't (or nothing is picked).
  const selected =
    signals.find((signal) => signal.id === selectedId) ?? signals[0] ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Signals</h1>
          <p className="text-sm text-muted-foreground">
            The messages competitors keep paying to run.
          </p>
        </div>
        {signals.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            disabled={rescoreMutation.isPending}
            onClick={() => rescoreMutation.mutate()}
          >
            {rescoreMutation.isPending ? "Checking…" : "Re-check scores"}
          </Button>
        )}
      </div>

      <EvidenceBanner />

      {ranked.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : signals.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-16">
          <Radar className="size-8 text-muted-foreground/40" />
          <div className="text-center">
            <p className="text-sm text-muted-foreground">{NO_CLUSTERS_NOTE}</p>
            <p className="text-[13px] text-muted-foreground/40">
              Fills run from the operator device — there is nothing to press
              here.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="overflow-hidden rounded-xl border">
            <SignalsLedger
              signals={signals}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
            />
          </div>
          {selected && <EvidencePanel signal={selected} />}
        </div>
      )}
    </div>
  );
}
