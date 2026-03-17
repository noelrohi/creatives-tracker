"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemMedia,
  ItemGroup,
} from "@/components/ui/item";
import {
  Image,
  Globe,
  Megaphone,
  Layers,
  Plus,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

export default function DashboardPage() {
  const trpc = useTRPC();
  const router = useRouter();

  const creatives = useQuery(trpc.adCreative.list.queryOptions({}));
  const landingPages = useQuery(trpc.landingPage.list.queryOptions());
  const campaigns = useQuery(trpc.campaignConfig.list.queryOptions());
  const adSets = useQuery(trpc.adSet.list.queryOptions());

  const isLoading =
    creatives.isLoading ||
    landingPages.isLoading ||
    campaigns.isLoading ||
    adSets.isLoading;

  // Collect recent items across all types
  const recentItems = !isLoading
    ? [
        ...(creatives.data ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          type: "Creative" as const,
          icon: Image,
          href: `/creatives/${c.id}`,
          detail: [c.format, c.angle].filter(Boolean).join(" · ") || null,
          date: c.createdAt,
        })),
        ...(landingPages.data ?? []).map((lp) => ({
          id: lp.id,
          name: lp.name,
          type: "Landing Page" as const,
          icon: Globe,
          href: `/landing-pages/${lp.id}`,
          detail: lp.url || null,
          date: lp.createdAt,
        })),
        ...(campaigns.data ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          type: "Campaign" as const,
          icon: Megaphone,
          href: `/campaigns/${c.id}`,
          detail: [c.objective, c.dailyBudget ? `$${c.dailyBudget}/day` : null]
            .filter(Boolean)
            .join(" · ") || null,
          date: c.createdAt,
        })),
        ...(adSets.data ?? []).map((a) => ({
          id: a.id,
          name: a.name,
          type: "Ad Set" as const,
          icon: Layers,
          href: `/ad-sets/${a.id}`,
          detail: [a.adCreativeName, a.campaignConfigName]
            .filter(Boolean)
            .join(" → ") || null,
          date: a.createdAt,
        })),
      ]
        .sort(
          (a, b) =>
            new Date(b.date).getTime() - new Date(a.date).getTime(),
        )
        .slice(0, 8)
    : [];

  const sections = [
    {
      label: "Creatives",
      count: creatives.data?.length ?? 0,
      href: "/creatives",
      icon: Image,
      color: "text-blue-500",
      bg: "bg-blue-500/10",
      onCreate: () =>
        trpc.adCreative.create.mutationOptions(),
    },
    {
      label: "Landing Pages",
      count: landingPages.data?.length ?? 0,
      href: "/landing-pages",
      icon: Globe,
      color: "text-emerald-500",
      bg: "bg-emerald-500/10",
    },
    {
      label: "Campaigns",
      count: campaigns.data?.length ?? 0,
      href: "/campaigns",
      icon: Megaphone,
      color: "text-amber-500",
      bg: "bg-amber-500/10",
    },
    {
      label: "Ad Sets",
      count: adSets.data?.length ?? 0,
      href: "/ad-sets",
      icon: Layers,
      color: "text-violet-500",
      bg: "bg-violet-500/10",
    },
  ];

  const totalItems =
    (creatives.data?.length ?? 0) +
    (landingPages.data?.length ?? 0) +
    (campaigns.data?.length ?? 0) +
    (adSets.data?.length ?? 0);

  return (
    <div className="flex flex-col gap-8">
      {/* ── Nav cards — compact row ─────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {sections.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="group flex items-center gap-3 rounded-lg border border-border px-3.5 py-3 transition-all hover:border-border hover:bg-muted/30"
          >
            <div
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-md",
                s.bg,
              )}
            >
              <s.icon className={cn("size-4", s.color)} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-muted-foreground/70">
                {s.label}
              </p>
              {isLoading ? (
                <Skeleton className="mt-0.5 h-5 w-8" />
              ) : (
                <p className="text-lg font-semibold tabular-nums leading-tight">
                  {s.count}
                </p>
              )}
            </div>
            <ArrowRight className="size-3.5 text-muted-foreground/0 transition-all group-hover:text-muted-foreground/40 group-hover:translate-x-0.5" />
          </Link>
        ))}
      </div>

      {/* ── Recent activity ─────────────────────────────────── */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground/50">
            Recent
          </h2>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5"
              >
                <Skeleton className="size-8 rounded-md" />
                <div className="flex-1 space-y-1">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
              </div>
            ))}
          </div>
        ) : totalItems === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-16">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted/50">
              <Sparkles className="size-5 text-muted-foreground/40" />
            </div>
            <div className="text-center">
              <p className="text-sm text-muted-foreground">
                Nothing here yet
              </p>
              <p className="text-[13px] text-muted-foreground/40">
                Start by creating a creative, landing page, or campaign.
              </p>
            </div>
            <div className="flex gap-2">
              <CreateButton trpc={trpc} router={router} entity="adCreative" label="Creative" href="/creatives" />
              <CreateButton trpc={trpc} router={router} entity="landingPage" label="Landing Page" href="/landing-pages" />
              <CreateButton trpc={trpc} router={router} entity="campaignConfig" label="Campaign" href="/campaigns" />
            </div>
          </div>
        ) : (
          <ItemGroup>
            {recentItems.map((item) => (
              <Item key={`${item.type}-${item.id}`} asChild variant="outline" size="sm">
                <Link
                  href={item.href}
                  className="hover:bg-muted/40 transition-colors"
                >
                  <ItemMedia variant="icon">
                    <div
                      className={cn(
                        "flex size-8 items-center justify-center rounded-md",
                        item.type === "Creative" && "bg-blue-500/10",
                        item.type === "Landing Page" && "bg-emerald-500/10",
                        item.type === "Campaign" && "bg-amber-500/10",
                        item.type === "Ad Set" && "bg-violet-500/10",
                      )}
                    >
                      <item.icon
                        className={cn(
                          "size-3.5",
                          item.type === "Creative" && "text-blue-500",
                          item.type === "Landing Page" && "text-emerald-500",
                          item.type === "Campaign" && "text-amber-500",
                          item.type === "Ad Set" && "text-violet-500",
                        )}
                      />
                    </div>
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{item.name}</ItemTitle>
                    <ItemDescription>
                      {item.detail || item.type}
                    </ItemDescription>
                  </ItemContent>
                  <span className="text-[11px] tabular-nums text-muted-foreground/40">
                    {new Date(item.date).toLocaleDateString()}
                  </span>
                </Link>
              </Item>
            ))}
          </ItemGroup>
        )}
      </div>
    </div>
  );
}

function CreateButton({
  trpc,
  router,
  entity,
  label,
  href,
}: {
  trpc: ReturnType<typeof useTRPC>;
  router: ReturnType<typeof useRouter>;
  entity: "adCreative" | "landingPage" | "campaignConfig";
  label: string;
  href: string;
}) {
  // Each entity has its own mutation to avoid union type issues
  const adCreative = useMutation({
    ...trpc.adCreative.create.mutationOptions(),
    onSuccess: (data) => router.push(`${href}/${data.id}`),
  });
  const landingPage = useMutation({
    ...trpc.landingPage.create.mutationOptions(),
    onSuccess: (data) => router.push(`${href}/${data.id}`),
  });
  const campaignConfig = useMutation({
    ...trpc.campaignConfig.create.mutationOptions(),
    onSuccess: (data) => router.push(`${href}/${data.id}`),
  });

  const mutations = { adCreative, landingPage, campaignConfig };
  const m = mutations[entity];

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => m.mutate({})}
      disabled={m.isPending}
      className="gap-1.5 text-[13px]"
    >
      <Plus className="size-3" />
      {label}
    </Button>
  );
}
