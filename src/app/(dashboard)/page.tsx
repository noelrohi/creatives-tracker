"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Image, Globe, Megaphone, Layers, Plus } from "lucide-react";

export default function DashboardPage() {
  const trpc = useTRPC();
  const creatives = useQuery(trpc.adCreative.list.queryOptions({}));
  const landingPages = useQuery(trpc.landingPage.list.queryOptions());
  const campaigns = useQuery(trpc.campaignConfig.list.queryOptions());
  const adSets = useQuery(trpc.adSet.list.queryOptions());

  const stats = [
    {
      label: "Creatives",
      count: creatives.data?.length ?? 0,
      icon: Image,
      href: "/creatives",
    },
    {
      label: "Landing Pages",
      count: landingPages.data?.length ?? 0,
      icon: Globe,
      href: "/landing-pages",
    },
    {
      label: "Campaigns",
      count: campaigns.data?.length ?? 0,
      icon: Megaphone,
      href: "/campaigns",
    },
    {
      label: "Ad Sets",
      count: adSets.data?.length ?? 0,
      icon: Layers,
      href: "/ad-sets",
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description="Resolution Tracker — tag what works and why."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Link key={stat.href} href={stat.href}>
            <Card className="transition-colors hover:bg-muted/50">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">
                  {stat.label}
                </CardTitle>
                <stat.icon className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stat.count}</div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Button asChild variant="outline">
          <Link href="/creatives/new">
            <Plus className="mr-2 size-4" /> New Creative
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/landing-pages/new">
            <Plus className="mr-2 size-4" /> New Landing Page
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/campaigns/new">
            <Plus className="mr-2 size-4" /> New Campaign
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/ad-sets/new">
            <Plus className="mr-2 size-4" /> New Ad Set
          </Link>
        </Button>
      </div>
    </div>
  );
}
