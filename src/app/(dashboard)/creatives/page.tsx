"use client";

import { useState, useMemo, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useQueryState, parseAsStringLiteral, parseAsInteger } from "nuqs";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemMedia,
  ItemGroup,
  ItemActions,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Plus,
  Search,
  Image as ImageIcon,
  Film,
  User,
  LayoutGrid,
  List,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  Trash2,
  CheckSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CreativeFormDialog } from "./creative-form-dialog";
import { toast } from "sonner";

// ── Constants ────────────────────────────────────────────────────────

const FORMATS = ["static", "video", "ugc", "carousel"] as const;
const AWARENESS = [
  "unaware",
  "problem_aware",
  "solution_aware",
  "product_aware",
  "most_aware",
] as const;

const FORMAT_META: Record<string, { icon: React.ReactNode; label: string }> = {
  static: { icon: <ImageIcon className="size-3.5" />, label: "Static" },
  video: { icon: <Film className="size-3.5" />, label: "Video" },
  ugc: { icon: <User className="size-3.5" />, label: "UGC" },
  carousel: { icon: <LayoutGrid className="size-3.5" />, label: "Carousel" },
};

const AWARENESS_COLORS: Record<string, string> = {
  unaware: "bg-zinc-500/15 text-zinc-500 dark:text-zinc-400",
  problem_aware: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  solution_aware: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  product_aware: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  most_aware: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
};

function prettify(s: string | null | undefined) {
  return s ? s.replace(/_/g, " ") : null;
}

const PAGE_SIZE = 12;

// ── Selection props interface ────────────────────────────────────────

interface SelectionProps {
  selecting: boolean;
  selected: Set<string>;
  toggleSelect: (id: string) => void;
}

// ── Page ─────────────────────────────────────────────────────────────

export default function CreativesPage() {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  // URL state via nuqs
  const [view, setView] = useQueryState(
    "view",
    parseAsStringLiteral(["grid", "list"] as const).withDefault("list"),
  );
  const [format, setFormat] = useQueryState(
    "format",
    parseAsStringLiteral(FORMATS).withDefault(undefined as unknown as (typeof FORMATS)[number]),
  );
  const [awareness, setAwareness] = useQueryState(
    "awareness",
    parseAsStringLiteral(AWARENESS).withDefault(undefined as unknown as (typeof AWARENESS)[number]),
  );
  const [search, setSearch] = useQueryState("q", { defaultValue: "" });
  const [page, setPage] = useQueryState("page", parseAsInteger.withDefault(1));

  // Data
  const creatives = useQuery(
    trpc.adCreative.list.queryOptions({
      format: format || undefined,
      awarenessLevel: awareness || undefined,
      search: search || undefined,
    }),
  );

  const [createOpen, setCreateOpen] = useState(false);

  // Multi-select state
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Delete mutation
  const deleteMutation = useMutation({
    ...trpc.adCreative.delete.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: trpc.adCreative.list.queryKey(),
      });
    },
  });

  // Selection helpers
  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (!creatives.data) return;
    setSelected((prev) => {
      if (prev.size === creatives.data.length) {
        return new Set();
      }
      return new Set(creatives.data.map((c) => c.id));
    });
  }, [creatives.data]);

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selected);
    try {
      await Promise.all(ids.map((id) => deleteMutation.mutateAsync({ id })));
      toast.success(`Deleted ${ids.length} creative${ids.length > 1 ? "s" : ""}`);
      setSelected(new Set());
      setSelecting(false);
      setDeleteOpen(false);
    } catch {
      toast.error("Failed to delete some creatives");
    }
  }, [selected, deleteMutation]);

  const exitSelecting = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  const selectionProps: SelectionProps = { selecting, selected, toggleSelect };

  // Pagination
  const total = creatives.data?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(() => {
    if (!creatives.data) return [];
    const start = (safePage - 1) * PAGE_SIZE;
    return creatives.data.slice(start, start + PAGE_SIZE);
  }, [creatives.data, safePage]);

  return (
    <div className="flex flex-col gap-4">
      {/* ── Toolbar ──────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-medium tracking-tight">Creatives</h1>
        {total > 0 ? (
          <span className="text-[13px] tabular-nums text-muted-foreground/50">
            {total}
          </span>
        ) : null}
        <div className="flex-1" />
        {total > 0 && (
          <Button
            size="sm"
            variant={selecting ? "ghost" : "outline"}
            onClick={selecting ? exitSelecting : () => setSelecting(true)}
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

      {/* ── Filters + View Toggle ────────────────────────────── */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/40" />
          <input
            placeholder="Search..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="h-8 w-full rounded-md bg-muted/40 pl-8 pr-3 text-[13px] outline-none placeholder:text-muted-foreground/30 focus:bg-muted/60 focus:ring-1 focus:ring-border transition-colors"
          />
        </div>
        <FilterPill
          value={format ?? "all"}
          onValueChange={(v) => {
            setFormat(v === "all" ? null : (v as (typeof FORMATS)[number]));
            setPage(1);
          }}
          placeholder="Format"
          options={[
            { label: "All Formats", value: "all" },
            ...FORMATS.map((f) => ({ label: FORMAT_META[f].label, value: f })),
          ]}
        />
        <FilterPill
          value={awareness ?? "all"}
          onValueChange={(v) => {
            setAwareness(v === "all" ? null : (v as (typeof AWARENESS)[number]));
            setPage(1);
          }}
          placeholder="Awareness"
          options={[
            { label: "All Levels", value: "all" },
            ...AWARENESS.map((a) => ({
              label: prettify(a)!,
              value: a,
            })),
          ]}
        />
        <div className="ml-auto flex items-center rounded-md border border-border/50 p-0.5">
          <button
            type="button"
            onClick={() => setView("list")}
            className={cn(
              "flex size-7 items-center justify-center rounded-sm transition-colors",
              view === "list"
                ? "bg-muted text-foreground"
                : "text-muted-foreground/50 hover:text-muted-foreground",
            )}
          >
            <List className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setView("grid")}
            className={cn(
              "flex size-7 items-center justify-center rounded-sm transition-colors",
              view === "grid"
                ? "bg-muted text-foreground"
                : "text-muted-foreground/50 hover:text-muted-foreground",
            )}
          >
            <LayoutGrid className="size-3.5" />
          </button>
        </div>
      </div>

      {/* ── Select All Row ─────────────────────────────────────── */}
      {selecting && total > 0 && (
        <div className="flex items-center gap-3 px-3 py-1.5">
          <Checkbox
            checked={selected.size === (creatives.data?.length ?? 0) && (creatives.data?.length ?? 0) > 0}
            onCheckedChange={toggleAll}
          />
          <span className="text-xs text-muted-foreground">
            {selected.size === 0
              ? "Select all"
              : `${selected.size} of ${creatives.data?.length ?? 0} selected`}
          </span>
        </div>
      )}

      {/* ── Content ──────────────────────────────────────────── */}
      {creatives.isLoading ? (
        view === "grid" ? (
          <MasonryLoadingSkeleton />
        ) : (
          <ListLoadingSkeleton />
        )
      ) : paginated.length === 0 ? (
        <EmptyState
          hasFilters={!!format || !!awareness || !!search}
          onClear={() => {
            setFormat(null);
            setAwareness(null);
            setSearch("");
            setPage(1);
          }}
          onCreate={() => setCreateOpen(true)}
        />
      ) : view === "grid" ? (
        <MasonryGrid items={paginated} {...selectionProps} />
      ) : (
        <ListView items={paginated} {...selectionProps} />
      )}

      {/* ── Pagination ───────────────────────────────────────── */}
      {totalPages > 1 ? (
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={safePage <= 1}
            onClick={() => setPage(safePage - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-[13px] tabular-nums text-muted-foreground">
            {safePage} / {totalPages}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={safePage >= totalPages}
            onClick={() => setPage(safePage + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      ) : null}

      {/* ── Floating Action Bar ──────────────────────────────── */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-2.5 shadow-lg">
            <span className="text-sm font-medium">
              {selected.size} selected
            </span>
            <Button
              size="sm"
              variant="destructive"
              className="gap-1.5"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={exitSelecting}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* ── Confirm Bulk Delete Dialog ───────────────────────── */}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${selected.size} creative${selected.size > 1 ? "s" : ""}`}
        description={`This will permanently delete ${selected.size} creative${selected.size > 1 ? "s" : ""}. This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={handleBulkDelete}
        loading={deleteMutation.isPending}
      />

      <CreativeFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={(id) => router.push(`/creatives/${id}`)}
      />
    </div>
  );
}

// ── Filter pill ─────────────────────────────────────────────────────

function FilterPill({
  value,
  onValueChange,
  placeholder,
  options,
}: {
  value: string;
  onValueChange: (v: string) => void;
  placeholder: string;
  options: { label: string; value: string }[];
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="h-8 w-auto gap-1 border-none bg-muted/40 px-3 text-[13px] capitalize shadow-none hover:bg-muted/60 [&>svg]:size-3">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} className="capitalize">
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Masonry Grid View ───────────────────────────────────────────────

type Creative = NonNullable<
  ReturnType<ReturnType<typeof useTRPC>["adCreative"]["list"]["queryOptions"]>["queryKey"]
> extends unknown
  ? {
      id: string;
      name: string;
      assetUrl: string | null;
      format: string | null;
      angle: string | null;
      persona: string | null;
      awarenessLevel: string | null;
      hook: string | null;
      tone: string[] | null;
      cta: string | null;
      landingPageName: string | null;
      [key: string]: unknown;
    }
  : never;

function MasonryGrid({ items, selecting, selected, toggleSelect }: { items: Creative[] } & SelectionProps) {
  // CSS columns masonry — simple, no JS layout needed
  return (
    <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 [&>*]:mb-3 [&>*]:break-inside-avoid">
      {items.map((creative) => {
        const isSelected = selected.has(creative.id);

        const cardContent = (
          <>
            {/* Thumbnail — variable height for masonry effect */}
            <div
              className={cn(
                "relative overflow-hidden bg-muted/20",
                creative.assetUrl ? "aspect-auto" : "aspect-[4/3]",
              )}
            >
              {creative.assetUrl ? (
                creative.assetUrl.match(/\.(mp4|webm|mov)(\?|$)/i) ? (
                  <div className="flex aspect-video items-center justify-center">
                    <Film className="size-8 text-muted-foreground/15" />
                  </div>
                ) : (
                  <img
                    src={creative.assetUrl}
                    alt={creative.name}
                    className="w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                  />
                )
              ) : (
                <div className="flex size-full items-center justify-center">
                  <ImageIcon className="size-8 text-muted-foreground/10" />
                </div>
              )}

              {/* Format chip */}
              {creative.format ? (
                <div className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-md bg-background/80 px-1.5 py-0.5 text-[10px] font-medium backdrop-blur-sm">
                  {FORMAT_META[creative.format]?.icon}
                  <span className="capitalize">
                    {FORMAT_META[creative.format]?.label}
                  </span>
                </div>
              ) : null}

              {/* Checkbox overlay when selecting */}
              {selecting && (
                <div className="absolute right-1.5 top-1.5 z-10">
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleSelect(creative.id)}
                    className="size-5 border-2 border-white bg-background/80 backdrop-blur-sm"
                  />
                </div>
              )}

              {/* Hover overlay — hook text */}
              {creative.hook && !selecting ? (
                <div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100">
                  <p className="line-clamp-2 p-2.5 text-[11px] leading-relaxed text-white/90">
                    &ldquo;{creative.hook}&rdquo;
                  </p>
                </div>
              ) : null}
            </div>

            {/* Body */}
            <div className="flex flex-col gap-1.5 p-2.5">
              <span className="line-clamp-1 text-[13px] font-medium leading-tight">
                {creative.name}
              </span>

              <div className="flex flex-wrap items-center gap-1">
                {creative.awarenessLevel ? (
                  <span
                    className={cn(
                      "inline-flex rounded px-1.5 py-px text-[10px] font-medium capitalize",
                      AWARENESS_COLORS[creative.awarenessLevel] ??
                        "bg-muted text-muted-foreground",
                    )}
                  >
                    {prettify(creative.awarenessLevel)}
                  </span>
                ) : null}
                {creative.angle ? (
                  <span className="line-clamp-1 text-[11px] text-muted-foreground/50">
                    {creative.angle}
                  </span>
                ) : null}
              </div>

              {creative.tone && creative.tone.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {creative.tone.slice(0, 3).map((t) => (
                    <Badge
                      key={t}
                      variant="secondary"
                      className="h-[18px] rounded px-1 text-[10px] font-normal capitalize"
                    >
                      {t.replace(/_/g, " ")}
                    </Badge>
                  ))}
                  {creative.tone.length > 3 ? (
                    <span className="self-center text-[10px] text-muted-foreground/30">
                      +{creative.tone.length - 3}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        );

        if (selecting) {
          return (
            <div
              key={creative.id}
              role="button"
              tabIndex={0}
              onClick={() => toggleSelect(creative.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleSelect(creative.id);
                }
              }}
              className={cn(
                "group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-card transition-all hover:border-border hover:shadow-sm",
                isSelected && "ring-2 ring-primary",
              )}
            >
              {cardContent}
            </div>
          );
        }

        return (
          <Link
            key={creative.id}
            href={`/creatives/${creative.id}`}
            className="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-all hover:border-border hover:shadow-sm"
          >
            {cardContent}
          </Link>
        );
      })}
    </div>
  );
}

// ── List View (using Item components) ───────────────────────────────

function ListView({ items, selecting, selected, toggleSelect }: { items: Creative[] } & SelectionProps) {
  return (
    <ItemGroup>
      {items.map((creative) => {
        const isSelected = selected.has(creative.id);

        const itemContent = (
          <>
            {selecting && (
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => toggleSelect(creative.id)}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                className="self-center"
              />
            )}
            <ItemMedia variant="image">
              {creative.assetUrl &&
              !creative.assetUrl.match(/\.(mp4|webm|mov)(\?|$)/i) ? (
                <img src={creative.assetUrl} alt="" />
              ) : (
                <div className="flex size-full items-center justify-center bg-muted/30">
                  {creative.format === "video" ? (
                    <Film className="size-3.5 text-muted-foreground/30" />
                  ) : (
                    <ImageIcon className="size-3.5 text-muted-foreground/30" />
                  )}
                </div>
              )}
            </ItemMedia>

            <ItemContent>
              <ItemTitle>{creative.name}</ItemTitle>
              <ItemDescription>
                {[
                  creative.angle,
                  creative.persona,
                  creative.landingPageName
                    ? `→ ${creative.landingPageName}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No details yet"}
              </ItemDescription>
            </ItemContent>

            <ItemActions>
              {creative.format ? (
                <Badge
                  variant="secondary"
                  className="h-5 gap-1 rounded px-1.5 text-[11px] font-normal capitalize"
                >
                  {FORMAT_META[creative.format]?.icon}
                  {FORMAT_META[creative.format]?.label}
                </Badge>
              ) : null}
              {creative.awarenessLevel ? (
                <span
                  className={cn(
                    "inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium capitalize",
                    AWARENESS_COLORS[creative.awarenessLevel] ??
                      "bg-muted text-muted-foreground",
                  )}
                >
                  {prettify(creative.awarenessLevel)}
                </span>
              ) : null}
            </ItemActions>
          </>
        );

        if (selecting) {
          return (
            <Item key={creative.id} asChild variant="outline" size="sm">
              <div
                role="button"
                tabIndex={0}
                onClick={() => toggleSelect(creative.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleSelect(creative.id);
                  }
                }}
                className={cn(
                  "cursor-pointer hover:bg-muted/40",
                  isSelected && "bg-muted/60",
                )}
              >
                {itemContent}
              </div>
            </Item>
          );
        }

        return (
          <Item key={creative.id} asChild variant="outline" size="sm">
            <Link
              href={`/creatives/${creative.id}`}
              className="hover:bg-muted/40"
            >
              {itemContent}
            </Link>
          </Item>
        );
      })}
    </ItemGroup>
  );
}

// ── Empty State ─────────────────────────────────────────────────────

function EmptyState({
  hasFilters,
  onClear,
  onCreate,
}: {
  hasFilters: boolean;
  onClear: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-20">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted/50">
        <Sparkles className="size-5 text-muted-foreground/40" />
      </div>
      <div className="text-center">
        <p className="text-sm text-muted-foreground">
          {hasFilters ? "No creatives match your filters" : "No creatives yet"}
        </p>
        <p className="text-[13px] text-muted-foreground/40">
          {hasFilters
            ? "Try adjusting your search or filters."
            : "Create your first creative to start tagging resolutions."}
        </p>
      </div>
      {hasFilters ? (
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear filters
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={onCreate}
        >
          <Plus className="mr-1.5 size-3.5" /> Create Creative
        </Button>
      )}
    </div>
  );
}

// ── Loading Skeletons ───────────────────────────────────────────────

function MasonryLoadingSkeleton() {
  // Varied heights for masonry feel
  const heights = [180, 140, 200, 160, 220, 150, 190, 170];
  return (
    <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 [&>*]:mb-3 [&>*]:break-inside-avoid">
      {heights.map((h, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-border p-0">
          <Skeleton className="w-full rounded-b-none rounded-t-lg" style={{ height: h }} />
          <div className="space-y-1.5 px-2.5 pb-2.5">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ListLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5"
        >
          <Skeleton className="size-8 rounded" />
          <div className="flex flex-1 flex-col gap-1">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-5 w-16 rounded" />
        </div>
      ))}
    </div>
  );
}
