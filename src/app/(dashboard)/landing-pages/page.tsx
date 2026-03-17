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
import { Plus, Globe, ExternalLink, Sparkles } from "lucide-react";

export default function LandingPagesPage() {
  const trpc = useTRPC();
  const router = useRouter();
  const { data: landingPages, isLoading } = useQuery(
    trpc.landingPage.list.queryOptions(),
  );

  const createMutation = useMutation({
    ...trpc.landingPage.create.mutationOptions(),
    onSuccess: (data) => {
      router.push(`/landing-pages/${data.id}`);
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-medium tracking-tight">Landing Pages</h1>
        {landingPages ? (
          <span className="text-[13px] tabular-nums text-muted-foreground/50">
            {landingPages.length}
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

      {isLoading ? (
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
              <Skeleton className="size-8 rounded-md" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-64" />
              </div>
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
      ) : landingPages?.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-20">
          <div className="flex size-12 items-center justify-center rounded-full bg-emerald-500/10">
            <Globe className="size-5 text-emerald-500/50" />
          </div>
          <div className="text-center">
            <p className="text-sm text-muted-foreground">No landing pages yet</p>
            <p className="text-[13px] text-muted-foreground/40">
              Track where your ads send traffic.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => createMutation.mutate({})}
            disabled={createMutation.isPending}
          >
            <Plus className="mr-1.5 size-3.5" /> Create Landing Page
          </Button>
        </div>
      ) : (
        <ItemGroup>
          {landingPages?.map((page) => (
            <Item key={page.id} asChild variant="outline" size="sm">
              <Link
                href={`/landing-pages/${page.id}`}
                className="hover:bg-muted/40 transition-colors"
              >
                <ItemMedia variant="icon">
                  <div className="flex size-8 items-center justify-center rounded-md bg-emerald-500/10">
                    <Globe className="size-3.5 text-emerald-500" />
                  </div>
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{page.name}</ItemTitle>
                  <ItemDescription>
                    {page.url ? (
                      <span className="flex items-center gap-1">
                        {page.url}
                        <ExternalLink className="size-3 shrink-0" />
                      </span>
                    ) : (
                      "No URL set"
                    )}
                  </ItemDescription>
                </ItemContent>
                <span className="text-[11px] tabular-nums text-muted-foreground/40">
                  {new Date(page.createdAt).toLocaleDateString()}
                </span>
              </Link>
            </Item>
          ))}
        </ItemGroup>
      )}
    </div>
  );
}
