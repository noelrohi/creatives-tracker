"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Plus, FlaskConical } from "lucide-react";
import { ABTestFormDialog } from "./ab-test-form-dialog";

const statusColors: Record<string, string> = {
  running: "bg-green-100 text-green-700 border-green-200",
  completed: "bg-blue-100 text-blue-700 border-blue-200",
  paused: "bg-yellow-100 text-yellow-700 border-yellow-200",
};

export default function ABTestsPage() {
  const trpc = useTRPC();
  const router = useRouter();
  const abTests = useQuery(trpc.abTest.list.queryOptions());
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-medium tracking-tight">A/B Tests</h1>
        {abTests.data ? (
          <span className="text-[13px] tabular-nums text-muted-foreground/50">
            {abTests.data.length}
          </span>
        ) : null}
        <div className="flex-1" />
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          className="gap-1.5"
        >
          <Plus className="size-3.5" />
          New
        </Button>
      </div>

      {abTests.isLoading ? (
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
            >
              <Skeleton className="size-8 rounded-md" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            </div>
          ))}
        </div>
      ) : abTests.data?.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-20">
          <div className="flex size-12 items-center justify-center rounded-full bg-emerald-500/10">
            <FlaskConical className="size-5 text-emerald-500/50" />
          </div>
          <div className="text-center">
            <p className="text-sm text-muted-foreground">No A/B tests yet</p>
            <p className="text-[13px] text-muted-foreground/40">
              Create a test to compare ad set variants.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="mr-1.5 size-3.5" /> Create A/B Test
          </Button>
        </div>
      ) : (
        <ItemGroup>
          {abTests.data?.map((test) => (
            <Item key={test.id} asChild variant="outline" size="sm">
              <Link
                href={`/ab-tests/${test.id}`}
                className="hover:bg-muted/40 transition-colors"
              >
                <ItemMedia variant="icon">
                  <div className="flex size-8 items-center justify-center rounded-md bg-emerald-500/10">
                    <FlaskConical className="size-3.5 text-emerald-500" />
                  </div>
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{test.name}</ItemTitle>
                  <ItemDescription>
                    {test.hypothesis
                      ? test.hypothesis.slice(0, 80) +
                        (test.hypothesis.length > 80 ? "..." : "")
                      : "No hypothesis"}
                    {" · "}
                    {test.variantCount} variant
                    {test.variantCount !== 1 ? "s" : ""}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge
                    variant="outline"
                    className={`capitalize ${statusColors[test.status] ?? ""}`}
                  >
                    {test.status}
                  </Badge>
                </ItemActions>
              </Link>
            </Item>
          ))}
        </ItemGroup>
      )}

      <ABTestFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={(id) => router.push(`/ab-tests/${id}`)}
      />
    </div>
  );
}
