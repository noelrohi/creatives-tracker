"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { LandingPageFormDialog } from "@/components/blocks/landing-pages/landing-page-form-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemMedia,
  ItemGroup,
} from "@/components/ui/item";
import { Plus, Globe, ExternalLink, Trash2, CheckSquare } from "lucide-react";
import { toast } from "sonner";

export default function LandingPagesPage() {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: landingPages, isLoading } = useQuery(
    trpc.landingPage.list.queryOptions(),
  );

  const deleteMutation = useMutation(
    trpc.landingPage.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.landingPage.list.queryOptions());
      },
    }),
  );

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (!landingPages) return;
    if (selected.size === landingPages.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(landingPages.map((p) => p.id)));
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selected);
    await Promise.all(ids.map((id) => deleteMutation.mutateAsync({ id })));
    toast.success(`Deleted ${ids.length} landing page${ids.length > 1 ? "s" : ""}`);
    exitSelecting();
  };

  const exitSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

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
        {landingPages && landingPages.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => (selecting ? exitSelecting() : setSelecting(true))}
            className="gap-1.5"
          >
            <CheckSquare className="size-3.5" />
            {selecting ? "Cancel" : "Select"}
          </Button>
        )}
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
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
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="mr-1.5 size-3.5" /> Create Landing Page
          </Button>
        </div>
      ) : (
        <>
          {selecting && landingPages && landingPages.length > 0 && (
            <div className="flex items-center gap-2 px-1">
              <Checkbox
                checked={selected.size === landingPages.length}
                onCheckedChange={toggleAll}
              />
              <span className="text-[13px] text-muted-foreground">
                Select all
              </span>
            </div>
          )}
          <ItemGroup>
            {landingPages?.map((page) =>
              selecting ? (
                <Item
                  key={page.id}
                  variant="outline"
                  size="sm"
                  className={`cursor-pointer hover:bg-muted/40 transition-colors ${selected.has(page.id) ? "bg-muted/60" : ""}`}
                  onClick={() => toggleSelect(page.id)}
                >
                  <Checkbox
                    checked={selected.has(page.id)}
                    onCheckedChange={() => toggleSelect(page.id)}
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    className="self-center"
                  />
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
                </Item>
              ) : (
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
              ),
            )}
          </ItemGroup>
        </>
      )}

      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-2.5 shadow-lg">
          <span className="text-sm tabular-nums text-muted-foreground">
            {selected.size} selected
          </span>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setDeleteOpen(true)}
            className="gap-1.5"
          >
            <Trash2 className="size-3.5" />
            Delete
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${selected.size} landing page${selected.size > 1 ? "s" : ""}`}
        description="This action cannot be undone. The selected landing pages will be permanently deleted."
        confirmLabel="Delete"
        onConfirm={handleBulkDelete}
        loading={deleteMutation.isPending}
      />

      <LandingPageFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={(id) => router.push(`/landing-pages/${id}`)}
      />
    </div>
  );
}
