"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemMedia,
  ItemGroup,
  ItemActions,
} from "@/components/ui/item";
import { Plus, Megaphone, Sparkles } from "lucide-react";

export default function CampaignsPage() {
  const trpc = useTRPC();
  const router = useRouter();
  const campaigns = useQuery(trpc.campaignConfig.list.queryOptions());

  const createMutation = useMutation({
    ...trpc.campaignConfig.create.mutationOptions(),
    onSuccess: (data) => {
      router.push(`/campaigns/${data.id}`);
    },
  });

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
        <Button
          size="sm"
          onClick={() => createMutation.mutate({})}
          disabled={createMutation.isPending}
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
            onClick={() => createMutation.mutate({})}
            disabled={createMutation.isPending}
          >
            <Plus className="mr-1.5 size-3.5" /> Create Campaign
          </Button>
        </div>
      ) : (
        <ItemGroup>
          {campaigns.data?.map((campaign) => (
            <Item key={campaign.id} asChild variant="outline" size="sm">
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
            </Item>
          ))}
        </ItemGroup>
      )}
    </div>
  );
}
