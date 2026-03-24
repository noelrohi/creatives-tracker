"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useQueryState, parseAsStringLiteral, parseAsString, parseAsBoolean } from "nuqs";
import { type ColumnDef } from "@tanstack/react-table";
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
import { DataTable } from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Search, Sparkles, Trash2, Upload, ArrowUpDown, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { StaleDataBanner } from "@/components/blocks/dashboard/data-freshness";
import { toast } from "sonner";

const FORMATS = ["static", "video", "ugc", "carousel"] as const;
const AWARENESS = [
  "unaware",
  "problem_aware",
  "solution_aware",
  "product_aware",
  "most_aware",
] as const;

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

interface Creative {
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
  landingPageId: string | null;
  landingPageName: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  totalSpend: string | null;
  avgRoas: string | null;
  totalConversions: number | null;
  adStatus: string | null;
  metaAdId: string | null;
}

const columns: ColumnDef<Creative>[] = [
  {
    id: "select",
    header: ({ table }) => (
      <Checkbox
        checked={table.getIsAllPageRowsSelected()}
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        onClick={(e) => e.stopPropagation()}
        aria-label="Select row"
      />
    ),
    enableSorting: false,
    size: 40,
  },
  {
    accessorKey: "name",
    header: ({ column }) => (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        Name
        <ArrowUpDown className="ml-1.5 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => (
      <span className="line-clamp-1 font-medium">{row.getValue("name")}</span>
    ),
  },
  {
    accessorKey: "adStatus",
    header: "Status",
    cell: ({ row }) => {
      const status = row.getValue("adStatus") as string | null;
      if (!status) return <span className="text-muted-foreground/30">—</span>;
      return (
        <Badge
          variant={status === "active" ? "outline" : "secondary"}
          className={cn(
            "text-[10px] capitalize",
            status === "active" && "text-emerald-600 border-emerald-500/30",
          )}
        >
          {status}
        </Badge>
      );
    },
    size: 80,
  },
  {
    accessorKey: "format",
    header: "Format",
    cell: ({ row }) => {
      const format = row.getValue("format") as string | null;
      return format ? (
        <Badge variant="secondary" className="text-[11px] capitalize">
          {format}
        </Badge>
      ) : (
        <span className="text-muted-foreground/30">—</span>
      );
    },
  },
  {
    accessorKey: "angle",
    header: "Angle",
    cell: ({ row }) => {
      const angle = row.getValue("angle") as string | null;
      return angle ? (
        <span className="line-clamp-1 text-sm">{angle}</span>
      ) : (
        <span className="text-muted-foreground/30">—</span>
      );
    },
  },
  {
    accessorKey: "awarenessLevel",
    header: "Awareness",
    cell: ({ row }) => {
      const level = row.getValue("awarenessLevel") as string | null;
      return level ? (
        <span
          className={cn(
            "inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium capitalize",
            AWARENESS_COLORS[level] ?? "bg-muted text-muted-foreground",
          )}
        >
          {prettify(level)}
        </span>
      ) : (
        <span className="text-muted-foreground/30">—</span>
      );
    },
  },
  {
    accessorKey: "totalSpend",
    header: ({ column }) => (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        Spend
        <ArrowUpDown className="ml-1.5 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => {
      const val = row.getValue("totalSpend") as string | null;
      if (val == null) return <span className="text-muted-foreground/30">—</span>;
      const n = parseFloat(val);
      return (
        <span className="tabular-nums">${n >= 100 ? n.toFixed(0) : n.toFixed(2)}</span>
      );
    },
    meta: { className: "text-right" },
  },
  {
    accessorKey: "avgRoas",
    header: ({ column }) => (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        ROAS
        <ArrowUpDown className="ml-1.5 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => {
      const val = row.getValue("avgRoas") as string | null;
      if (val == null) return <span className="text-muted-foreground/30">—</span>;
      return <span className="tabular-nums">{parseFloat(val).toFixed(2)}x</span>;
    },
    meta: { className: "text-right" },
  },
  {
    accessorKey: "totalConversions",
    header: ({ column }) => (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        Conv
        <ArrowUpDown className="ml-1.5 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => {
      const val = row.getValue("totalConversions") as number | null;
      if (val == null) return <span className="text-muted-foreground/30">—</span>;
      return <span className="tabular-nums">{val}</span>;
    },
    meta: { className: "text-right" },
  },
  {
    accessorKey: "metaAdId",
    header: "",
    cell: ({ row, table }) => {
      const metaId = row.getValue("metaAdId") as string | null;
      if (!metaId) return null;
      const metaAccountId = (table.options.meta as { metaAccountId?: string })?.metaAccountId ?? "";
      const url = `https://www.facebook.com/adsmanager/manage/ads?act=${metaAccountId}&selected_ad_ids=${metaId}`;
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          title="View in Meta Ads Manager"
        >
          <ExternalLink className="size-3" />
          Meta
        </a>
      );
    },
    enableSorting: false,
    size: 60,
  },
];

export default function CreativesPage() {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [format, setFormat] = useQueryState(
    "format",
    parseAsStringLiteral(FORMATS).withDefault(undefined as unknown as (typeof FORMATS)[number]),
  );
  const [awareness, setAwareness] = useQueryState(
    "awareness",
    parseAsStringLiteral(AWARENESS).withDefault(undefined as unknown as (typeof AWARENESS)[number]),
  );
  const [search, setSearch] = useQueryState("q", { defaultValue: "" });
  const [accountId, setAccountId] = useQueryState("account", parseAsString.withDefault(""));
  const [untagged, setUntagged] = useQueryState("untagged", parseAsBoolean.withDefault(false));

  const accountsQuery = useQuery(trpc.account.list.queryOptions());
  const metaAccountId = accountsQuery.data?.find((a) => a.id === accountId)?.metaAccountId
    ?? accountsQuery.data?.[0]?.metaAccountId ?? "";

  const creatives = useQuery(
    trpc.adCreative.list.queryOptions({
      format: format || undefined,
      awarenessLevel: awareness || undefined,
      search: search || undefined,
      accountId: accountId || undefined,
      untaggedOnly: untagged || undefined,
    }),
  );

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});

  const deleteMutation = useMutation({
    ...trpc.adCreative.delete.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.adCreative.list.queryKey() });
    },
  });

  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);
  const selectedCreativeIds = selectedIds
    .map((idx) => creatives.data?.[Number(idx)]?.id)
    .filter(Boolean) as string[];

  const handleBulkDelete = useCallback(async () => {
    try {
      await Promise.all(selectedCreativeIds.map((id) => deleteMutation.mutateAsync({ id })));
      toast.success(`Deleted ${selectedCreativeIds.length} creative${selectedCreativeIds.length > 1 ? "s" : ""}`);
      setRowSelection({});
      setDeleteOpen(false);
    } catch {
      toast.error("Failed to delete some creatives");
    }
  }, [selectedCreativeIds, deleteMutation]);

  const total = creatives.data?.length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-medium tracking-tight">Creatives</h1>
        {total > 0 && (
          <span className="text-[13px] tabular-nums text-muted-foreground/50">{total}</span>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="outline" asChild className="gap-1.5">
          <Link href="/import"><Upload className="size-3.5" /> Import</Link>
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/40" />
          <input
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-full rounded-md bg-muted/40 pl-8 pr-3 text-[13px] outline-none placeholder:text-muted-foreground/30 focus:bg-muted/60 focus:ring-1 focus:ring-border transition-colors"
          />
        </div>
        <FilterPill
          value={format ?? "all"}
          onValueChange={(v) => setFormat(v === "all" ? null : (v as (typeof FORMATS)[number]))}
          placeholder="Format"
          options={[
            { label: "All Formats", value: "all" },
            ...FORMATS.map((f) => ({ label: f.charAt(0).toUpperCase() + f.slice(1), value: f })),
          ]}
        />
        <FilterPill
          value={awareness ?? "all"}
          onValueChange={(v) => setAwareness(v === "all" ? null : (v as (typeof AWARENESS)[number]))}
          placeholder="Awareness"
          options={[
            { label: "All Levels", value: "all" },
            ...AWARENESS.map((a) => ({ label: prettify(a)!, value: a })),
          ]}
        />
        {accountsQuery.data && accountsQuery.data.length > 0 && (
          <FilterPill
            value={accountId || "all"}
            onValueChange={(v) => setAccountId(v === "all" ? "" : v)}
            placeholder="Account"
            options={[
              { label: "All Accounts", value: "all" },
              ...accountsQuery.data.map((a) => ({ label: a.name, value: a.id })),
            ]}
          />
        )}
        <button
          type="button"
          onClick={() => setUntagged(!untagged)}
          className={cn(
            "h-8 rounded-md px-3 text-[13px] transition-colors",
            untagged
              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
              : "bg-muted/40 text-muted-foreground hover:bg-muted/60",
          )}
        >
          Untagged
        </button>
      </div>

      <StaleDataBanner
        account={accountsQuery.data?.find((a) => a.id === accountId) ?? accountsQuery.data?.[0]}
      />

      {/* Data Table */}
      {creatives.isLoading ? (
        <TableLoadingSkeleton />
      ) : total === 0 ? (
        <EmptyState
          hasFilters={!!format || !!awareness || !!search || !!untagged}
          onClear={() => { setFormat(null); setAwareness(null); setSearch(""); setUntagged(false); setAccountId(""); }}
          onImport={() => router.push("/import")}
        />
      ) : (
        <DataTable
          columns={columns}
          data={(creatives.data ?? []) as Creative[]}
          onRowClick={(row) => router.push(`/creatives/${row.id}`)}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          meta={{ metaAccountId }}
        />
      )}

      {/* Floating action bar */}
      {selectedCreativeIds.length > 0 && (
        <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-2.5 shadow-lg">
            <span className="text-sm font-medium">{selectedCreativeIds.length} selected</span>
            <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRowSelection({})}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${selectedCreativeIds.length} creative${selectedCreativeIds.length > 1 ? "s" : ""}`}
        description={`This will permanently delete ${selectedCreativeIds.length} creative${selectedCreativeIds.length > 1 ? "s" : ""}. This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={handleBulkDelete}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}

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

function EmptyState({
  hasFilters,
  onClear,
  onImport,
}: {
  hasFilters: boolean;
  onClear: () => void;
  onImport: () => void;
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
          {hasFilters ? "Try adjusting your search or filters." : "Import your Meta Ads Manager report to get started."}
        </p>
      </div>
      {hasFilters ? (
        <Button size="sm" variant="ghost" onClick={onClear}>Clear filters</Button>
      ) : (
        <Button size="sm" variant="outline" onClick={onImport} className="gap-1.5">
          <Upload className="size-3.5" /> Import Ads
        </Button>
      )}
    </div>
  );
}

function TableLoadingSkeleton() {
  return (
    <div className="rounded-lg border">
      <div className="divide-y">
        <div className="grid grid-cols-8 gap-4 px-4 py-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="grid grid-cols-8 gap-4 px-4 py-3">
            {Array.from({ length: 8 }).map((_, j) => (
              <Skeleton key={j} className="h-4 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
