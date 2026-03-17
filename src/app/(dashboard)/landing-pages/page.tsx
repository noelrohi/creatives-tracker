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

export default function LandingPagesPage() {
  const trpc = useTRPC();
  const { data: landingPages, isLoading } = useQuery(
    trpc.landingPage.list.queryOptions(),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Landing Pages"
        description="Manage your landing pages and their versions."
      >
        <Button asChild>
          <Link href="/landing-pages/new">
            <Plus className="mr-2 size-4" /> New Landing Page
          </Link>
        </Button>
      </PageHeader>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={3} className="text-center">
                  Loading...
                </TableCell>
              </TableRow>
            ) : landingPages?.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="text-center text-muted-foreground"
                >
                  No landing pages yet. Create your first one.
                </TableCell>
              </TableRow>
            ) : (
              landingPages?.map((page) => (
                <TableRow key={page.id}>
                  <TableCell>
                    <Link
                      href={`/landing-pages/${page.id}`}
                      className="font-medium hover:underline"
                    >
                      {page.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {page.url}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(page.createdAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
