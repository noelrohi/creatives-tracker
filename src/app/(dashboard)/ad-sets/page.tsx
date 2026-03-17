"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { AdSetFormDialog } from "./ad-set-form-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  ItemActions,
} from "@/components/ui/item";
import { Plus, Layers, Trash2, CheckSquare } from "lucide-react";
import { toast } from "sonner";

export default function AdSetsPage() {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const adSets = useQuery(trpc.adSet.list.queryOptions());
  const [createOpen, setCreateOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);

  const deleteMutation = useMutation({
    ...trpc.adSet.delete.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.adSet.list.queryOptions().queryKey });
    },
  });

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleAll() {
    if (!adSets.data) return;
    if (selected.size === adSets.data.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(adSets.data.map((a) => a.id)));
    }
  }

  async function handleBulkDelete() {
    const ids = Array.from(selected);
    try {
      await Promise.all(ids.map((id) => deleteMutation.mutateAsync({ id })));
      toast.success(`Deleted ${ids.length} ad set${ids.length > 1 ? "s" : ""}`);
      exitSelecting();
    } catch {
      toast.error("Failed to delete some ad sets");
    }
  }

  function exitSelecting() {
    setSelecting(false);
    setSelected(new Set());
  }

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
        {adSets.data && adSets.data.length > 0 && (
          <Button
            size="sm"
            variant={selecting ? "outline" : "ghost"}
            onClick={() => {
              if (selecting) {
                exitSelecting();
              } else {
                setSelecting(true);
              }
            }}
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
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="mr-1.5 size-3.5" /> Create Ad Set
          </Button>
        </div>
      ) : (
        <>
          {selecting && adSets.data && adSets.data.length > 0 && (
            <button
              type="button"
              onClick={toggleAll}
              className="flex items-center gap-2.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:bg-muted/40 transition-colors"
            >
              <Checkbox
                checked={selected.size === adSets.data.length}
                onCheckedChange={toggleAll}
              />
              {selected.size === adSets.data.length
                ? "Deselect all"
                : "Select all"}
            </button>
          )}
          <ItemGroup>
            {adSets.data?.map((adSet) =>
              selecting ? (
                <Item
                  key={adSet.id}
                  variant="outline"
                  size="sm"
                  className={`cursor-pointer hover:bg-muted/40 transition-colors ${
                    selected.has(adSet.id) ? "bg-muted/60" : ""
                  }`}
                  onClick={() => toggleSelect(adSet.id)}
                >
                  <div className="flex items-center pl-0.5 pr-1">
                    <Checkbox
                      checked={selected.has(adSet.id)}
                      onCheckedChange={() => toggleSelect(adSet.id)}
                    />
                  </div>
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
                </Item>
              ) : (
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
              )
            )}
          </ItemGroup>
        </>
      )}

      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-background px-4 py-2.5 shadow-lg">
          <span className="text-sm font-medium tabular-nums">
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
        title={`Delete ${selected.size} ad set${selected.size > 1 ? "s" : ""}`}
        description={`This will permanently delete ${selected.size} ad set${selected.size > 1 ? "s" : ""}. This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={handleBulkDelete}
        loading={deleteMutation.isPending}
      />

      <AdSetFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={(id) => router.push(`/ad-sets/${id}`)}
      />
    </div>
  );
}
