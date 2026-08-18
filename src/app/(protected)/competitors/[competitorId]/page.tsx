"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CompetitorAdsGrid } from "@/components/blocks/competitor-signals/competitor-ads-grid";
import { useBreadcrumbs } from "@/components/breadcrumbs";
import { ArrowLeft } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { useTRPC } from "@/lib/trpc/client";

export default function CompetitorAdsPage() {
  const { competitorId } = useParams<{ competitorId: string }>();
  const trpc = useTRPC();

  const ads = useQuery(
    trpc.signals.listCompetitorAds.queryOptions({ competitorId }),
  );

  useBreadcrumbs([
    { label: "Competitors", href: "/competitors" },
    { label: ads.data?.competitor.name ?? "Ads" },
  ]);

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/competitors"
        className="flex w-fit items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> All competitors
      </Link>

      {ads.isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-12 w-80 rounded-lg" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-96 rounded-xl" />
            ))}
          </div>
        </div>
      ) : ads.data ? (
        <CompetitorAdsGrid data={ads.data} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {ads.error?.message ?? "Competitor not found"}
        </p>
      )}
    </div>
  );
}
