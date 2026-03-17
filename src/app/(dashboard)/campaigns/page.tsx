"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus } from "lucide-react";

export default function CampaignsPage() {
  const trpc = useTRPC();
  const campaigns = useQuery(trpc.campaignConfig.list.queryOptions());

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Campaigns" description="Manage your campaign configurations.">
        <Button asChild>
          <Link href="/campaigns/new">
            <Plus className="mr-2 size-4" /> New Campaign
          </Link>
        </Button>
      </PageHeader>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Objective</TableHead>
              <TableHead>Daily Budget</TableHead>
              <TableHead>Geos</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.data?.map((campaign) => (
              <TableRow key={campaign.id}>
                <TableCell>
                  <Link
                    href={`/campaigns/${campaign.id}`}
                    className="font-medium hover:underline"
                  >
                    {campaign.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{campaign.objective}</Badge>
                </TableCell>
                <TableCell>${campaign.dailyBudget}</TableCell>
                <TableCell>{campaign.geos.join(", ")}</TableCell>
                <TableCell>
                  {new Date(campaign.createdAt).toLocaleDateString()}
                </TableCell>
              </TableRow>
            ))}
            {campaigns.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No campaigns yet. Create your first one.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
