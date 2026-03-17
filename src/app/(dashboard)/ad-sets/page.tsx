"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus } from "lucide-react";

export default function AdSetsPage() {
  const trpc = useTRPC();
  const adSets = useQuery(trpc.adSet.list.queryOptions());

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Ad Sets" description="Manage your ad set configurations.">
        <Button asChild>
          <Link href="/ad-sets/new">
            <Plus className="mr-2 size-4" /> New Ad Set
          </Link>
        </Button>
      </PageHeader>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Creative Name</TableHead>
              <TableHead>Landing Page</TableHead>
              <TableHead>Campaign</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {adSets.data?.map((adSet) => (
              <TableRow key={adSet.id}>
                <TableCell>
                  <Link
                    href={`/ad-sets/${adSet.id}`}
                    className="font-medium hover:underline"
                  >
                    {adSet.name}
                  </Link>
                </TableCell>
                <TableCell>{adSet.adCreativeName ?? "-"}</TableCell>
                <TableCell>
                  {adSet.landingPageName
                    ? `${adSet.landingPageName} v${adSet.landingPageVersion}`
                    : "-"}
                </TableCell>
                <TableCell>{adSet.campaignConfigName ?? "-"}</TableCell>
                <TableCell>
                  {new Date(adSet.createdAt).toLocaleDateString()}
                </TableCell>
              </TableRow>
            ))}
            {adSets.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No ad sets yet. Create your first one.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
