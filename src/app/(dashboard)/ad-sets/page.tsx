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
import { Plus, Layers, Sparkles } from "lucide-react";

export default function AdSetsPage() {
  const trpc = useTRPC();
  const router = useRouter();
  const adSets = useQuery(trpc.adSet.list.queryOptions());

  const createMutation = useMutation({
    ...trpc.adSet.create.mutationOptions(),
    onSuccess: (data) => {
      router.push(`/ad-sets/${data.id}`);
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-medium tracking-tight">Ad Sets</h1>
        {adSets.data ? (
          <span className="text-[13px] tabular-nums text-muted-foreground/50">
            {adSets.data.length}
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

      {adSets.isLoading ? (
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
              <Skeleton className="size-8 rounded-md" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            </div>
          ))}
        </div>
      ) : adSets.data?.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-20">
          <div className="flex size-12 items-center justify-center rounded-full bg-violet-500/10">
            <Layers className="size-5 text-violet-500/50" />
          </div>
          <div className="text-center">
            <p className="text-sm text-muted-foreground">No ad sets yet</p>
            <p className="text-[13px] text-muted-foreground/40">
              Link a creative + landing page + campaign together.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => createMutation.mutate({})}
            disabled={createMutation.isPending}
          >
            <Plus className="mr-1.5 size-3.5" /> Create Ad Set
          </Button>
        </div>
      ) : (
        <ItemGroup>
          {adSets.data?.map((adSet) => (
            <Item key={adSet.id} asChild variant="outline" size="sm">
              <Link
                href={`/ad-sets/${adSet.id}`}
                className="hover:bg-muted/40 transition-colors"
              >
                <ItemMedia variant="icon">
                  <div className="flex size-8 items-center justify-center rounded-md bg-violet-500/10">
                    <Layers className="size-3.5 text-violet-500" />
                  </div>
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{adSet.name}</ItemTitle>
                  <ItemDescription>
                    {[
                      adSet.adCreativeName,
                      adSet.landingPageName
                        ? `${adSet.landingPageName}${adSet.landingPageVersion ? ` v${adSet.landingPageVersion}` : ""}`
                        : null,
                      adSet.campaignConfigName,
                    ]
                      .filter(Boolean)
                      .join(" → ") || "No links yet"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {adSet.adCreativeName ? (
                    <Badge
                      variant="secondary"
                      className="h-5 rounded px-1.5 text-[11px] font-normal"
                    >
                      {adSet.adCreativeName}
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
