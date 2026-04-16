"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useQueryState, parseAsStringLiteral, parseAsString } from "nuqs";
import { type ColumnDef } from "@tanstack/react-table";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
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
import { DataTable, DataTableColumnToggle } from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Search,
  Sparkles,
  Trash2,
  Upload,
  ArrowUpDown,
  MoreHorizontal,
  Copy,
  ChevronsUpDown,
  Check,
  ImageIcon,
  Video,
  UserCheck,
  ExternalLink,
  Download,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { StaleDataBanner } from "@/components/blocks/dashboard/data-freshness";
import { ExportPreviewDialog } from "@/components/blocks/export-preview-dialog";
import { DateRangePicker } from "@/components/blocks/dashboard/date-range-picker";
import { subDays } from "date-fns";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date";
import { toast } from "sonner";
import type { CreativeHealth } from "@/lib/creative-health";

const FORMATS = ["static", "video", "ugc", "carousel"] as const;
const AWARENESS = [
  "unaware",
  "problem_aware",
  "solution_aware",
  "product_aware",
  "most_aware",
] as const;

const HEALTH_STYLES: Record<CreativeHealth, { label: string; className: string }> = {
  healthy: { label: "Healthy", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  warning: { label: "Warning", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  critical: { label: "Critical", className: "bg-red-500/15 text-red-500 dark:text-red-400" },
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

function formatDateTime(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return {
    date: date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    time: date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }),
  };
}

interface Creative {
  id: string;
  name: string;
  assetUrl: string | null;
  videoUrl: string | null;
  destinationUrl: string | null;
  format: string | null;
  angle: string | null;
  persona: string | null;
  awarenessLevel: string | null;
  hook: string | null;
  tone: string[] | null;
  cta: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  totalSpend: string | null;
  avgRoas: string | null;
  avgCpa: string | null;
  avgCtr: string | null;
  totalConversions: number | null;
  adStatus: string | null;
  metaAdId: string | null;
  metaCampaignId: string | null;
  metaAdSetId: string | null;
  accountName: string | null;
  teamId: string | null;
  // Trend metrics for health
  recentCtr: string | null;
  recentCpc: string | null;
  avgCpc: string | null;
  avgFrequency: string | null;
  recentHookRate: string | null;
  priorHookRate: string | null;
  recentCpa: string | null;
  thumbstopRatio: string | null;
  health: CreativeHealth | null;
  healthReasons: string[];
}

function MediaPreview({ creative }: { creative: Creative }) {
  const href = creative.videoUrl || creative.assetUrl;

  if (!href) {
    return (
      <div className="flex size-10 items-center justify-center rounded-md bg-muted">
        <ImageIcon className="size-4 text-muted-foreground/40" />
      </div>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="block"
    >
      {creative.assetUrl ? (
        <div className="relative size-10 overflow-hidden rounded-md bg-muted">
          <img
            src={creative.assetUrl}
            alt=""
            className="size-full object-cover"
          />
          {creative.format === "video" && (
            <Video className="absolute inset-0 m-auto size-4 text-white drop-shadow" />
          )}
        </div>
      ) : (
        <div className="flex size-10 items-center justify-center rounded-md bg-muted">
          {creative.format === "video" ? (
            <Video className="size-4 text-muted-foreground/60" />
          ) : (
            <ImageIcon className="size-4 text-muted-foreground/40" />
          )}
        </div>
      )}
    </a>
  );
}

const columns: ColumnDef<Creative>[] = [
  {
    id: "select",
    enableHiding: false,
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
    id: "media",
    header: "Media",
    cell: ({ row }) => <MediaPreview creative={row.original} />,
    enableSorting: false,
    size: 56,
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
    accessorKey: "accountName",
    header: "Account",
    cell: ({ row }) => {
      const name = row.getValue("accountName") as string | null;
      if (!name) return <span className="text-muted-foreground/30">—</span>;
      return <span className="text-sm text-muted-foreground truncate max-w-[120px]">{name}</span>;
    },
  },
  {
    accessorKey: "destinationUrl",
    header: "Landing Page",
    cell: ({ row }) => {
      const url = row.getValue("destinationUrl") as string | null;
      if (!url) return <span className="text-muted-foreground/30">—</span>;
      let display: string;
      try {
        const parsed = new URL(url);
        display = parsed.pathname !== "/" ? parsed.pathname : parsed.hostname.replace(/^www\./, "");
      } catch {
        display = url;
      }
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground truncate max-w-[120px]"
            >
              <span className="truncate">{display}</span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs break-all text-xs">
            {url}
          </TooltipContent>
        </Tooltip>
      );
    },
  },
  {
    accessorKey: "teamId",
    header: "Team",
    cell: ({ row, table }) => {
      const teamId = row.getValue("teamId") as string | null;
      if (!teamId) return <span className="text-muted-foreground/30">&mdash;</span>;
      const teams = (table.options.meta as Record<string, unknown>)?.teams as Record<string, string> | undefined;
      const name = teams?.[teamId];
      return (
        <Badge variant="secondary" className="text-[10px]">
          {name ?? teamId}
        </Badge>
      );
    },
    size: 100,
  },
  {
    accessorKey: "updatedAt",
    header: ({ column }) => (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        Last Synced
        <ArrowUpDown className="ml-1.5 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => {
      const formatted = formatDateTime(row.original.updatedAt);
      return (
        <div className="min-w-[108px]">
          <div className="text-sm tabular-nums">{formatted.date}</div>
          <div className="text-xs text-muted-foreground tabular-nums">{formatted.time}</div>
        </div>
      );
    },
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
    accessorKey: "avgCpa",
    header: ({ column }) => (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        CPA
        <ArrowUpDown className="ml-1.5 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => {
      const val = row.getValue("avgCpa") as string | null;
      if (val == null) return <span className="text-muted-foreground/30">—</span>;
      const n = parseFloat(val);
      return <span className="tabular-nums">${n >= 100 ? n.toFixed(0) : n.toFixed(2)}</span>;
    },
    meta: { className: "text-right" },
  },
  {
    accessorKey: "avgCtr",
    header: ({ column }) => (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        CTR
        <ArrowUpDown className="ml-1.5 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => {
      const val = row.getValue("avgCtr") as string | null;
      if (val == null) return <span className="text-muted-foreground/30">—</span>;
      return <span className="tabular-nums">{parseFloat(val).toFixed(2)}%</span>;
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
    id: "health",
    header: "Health",
    cell: ({ row }) => {
      const health = row.original.health;
      if (!health) return <span className="text-muted-foreground/30">—</span>;
      const style = HEALTH_STYLES[health];
      const reasons = row.original.healthReasons ?? [];
      const badge = (
        <span className={cn("inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium", style.className)}>
          {style.label}
        </span>
      );
      if (reasons.length === 0) return badge;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help">{badge}</span>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-xs">
            <ul className="list-disc pl-4 space-y-0.5">
              {reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </TooltipContent>
        </Tooltip>
      );
    },
    size: 80,
  },
  {
    id: "actions",
    header: "",
    cell: ({ row }) => {
      const metaAdId = row.original.metaAdId;
      const metaCampaignId = row.original.metaCampaignId;
      const metaAdSetId = row.original.metaAdSetId;
      if (!metaAdId && !metaCampaignId && !metaAdSetId) return null;

      const copyToClipboard = (value: string, label: string) => {
        navigator.clipboard.writeText(value);
        toast.success(`${label} copied`);
      };

      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {metaAdId && (
              <DropdownMenuItem onClick={() => copyToClipboard(metaAdId, "Ad ID")}>
                <Copy className="size-3.5" />
                Copy Ad ID
              </DropdownMenuItem>
            )}
            {metaAdSetId && (
              <DropdownMenuItem onClick={() => copyToClipboard(metaAdSetId, "Ad Set ID")}>
                <Copy className="size-3.5" />
                Copy Ad Set ID
              </DropdownMenuItem>
            )}
            {metaCampaignId && (
              <DropdownMenuItem onClick={() => copyToClipboard(metaCampaignId, "Campaign ID")}>
                <Copy className="size-3.5" />
                Copy Campaign ID
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      );
    },
    enableSorting: false,
    enableHiding: false,
    size: 40,
  },
];

export default function CreativesPage() {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { role } = useActiveOrganizationRole();
  const isReadOnly = role === "member";
  const tableColumns = isReadOnly
    ? columns.filter((column) => column.id !== "select")
    : columns;

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
  const [adSetIds, setAdSetIds] = useQueryState("adSet", parseAsString.withDefault(""));
  const [healthFilter, setHealthFilter] = useQueryState("health", parseAsString.withDefault(""));
  const [teamId, setTeamId] = useQueryState("team", parseAsString.withDefault(""));
  const [from, setFrom] = useQueryState("from", parseAsString.withDefault(formatDateOnly(subDays(new Date(), 6))));
  const [to, setTo] = useQueryState("to", parseAsString.withDefault(formatDateOnly(new Date())));
  const fromValue = isDateOnlyString(from) ? from : formatDateOnly(subDays(new Date(), 6));
  const toValue = isDateOnlyString(to) ? to : formatDateOnly(new Date());
  const fromDate = parseDateOnly(fromValue);
  const toDate = parseDateOnly(toValue);

  const accountsQuery = useQuery(trpc.adAccount.list.queryOptions());
  const adSetsQuery = useQuery(trpc.adSet.list.queryOptions());
  const teamsQuery = useQuery(trpc.team.list.queryOptions());
  const metaAccountId = accountsQuery.data?.find((a) => a.id === accountId)?.metaAccountId
    ?? accountsQuery.data?.[0]?.metaAccountId ?? "";

  const creatives = useQuery(
    trpc.adCreative.list.queryOptions({
      format: format || undefined,
      awarenessLevel: awareness || undefined,
      search: search || undefined,
      accountId: accountId ? accountId : undefined,
      adSetIds: adSetIds ? adSetIds.split(",") : undefined,
      teamId: teamId || undefined,
      from: fromValue,
      to: toValue,
    }),
  );

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({
    angle: false,
    awarenessLevel: false,
    format: false,
    health: false,
    avgCpa: false,
  });

  const deleteMutation = useMutation({
    ...trpc.adCreative.delete.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.adCreative.list.queryKey() });
    },
  });



  const healthValues = healthFilter ? healthFilter.split(",").filter(Boolean) as CreativeHealth[] : [];

  const creativeRows = [...(creatives.data ?? [])]
    .filter((c) => {
      if (healthValues.length === 0) return true;
      return c.health != null && healthValues.includes(c.health);
    })
;

  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);
  const selectedCreativeIds = selectedIds;

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

  const exportFilterLabels = (() => {
    const labels: { label: string; value: string }[] = [];
    if (format) labels.push({ label: "Format", value: format });
    if (awareness) labels.push({ label: "Awareness", value: awareness });
    if (search) labels.push({ label: "Search", value: search });
    if (accountId) {
      const name = accountsQuery.data?.find((a) => a.id === accountId)?.name ?? accountId;
      labels.push({ label: "Account", value: name });
    }
    if (teamId) {
      const name = teamsQuery.data?.find((t) => t.id === teamId)?.name ?? teamId;
      labels.push({ label: "Team", value: name });
    }
    if (adSetIds) {
      const count = adSetIds.split(",").filter(Boolean).length;
      labels.push({ label: "Ad sets", value: `${count} selected` });
    }
    if (healthFilter) labels.push({ label: "Health", value: healthFilter });
    return labels;
  })();



  const [teamDialogOpen, setTeamDialogOpen] = useState(false);
  const [selectedTeamValue, setSelectedTeamValue] = useState<string>("");

  const bulkTeamMutation = useMutation({
    ...trpc.adCreative.bulkUpdateTeam.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.adCreative.list.queryKey() });
    },
  });

  const handleUpdateTeam = useCallback(async () => {
    try {
      const teamIdValue = selectedTeamValue === "none" ? null : selectedTeamValue;
      await bulkTeamMutation.mutateAsync({ ids: selectedCreativeIds, teamId: teamIdValue });
      toast.success(`Updated team for ${selectedCreativeIds.length} creative${selectedCreativeIds.length > 1 ? "s" : ""}`);
      setRowSelection({});
      setTeamDialogOpen(false);
      setSelectedTeamValue("");
    } catch {
      toast.error("Failed to update team");
    }
  }, [selectedCreativeIds, selectedTeamValue, bulkTeamMutation]);

  const total = creativeRows.length;

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-medium tracking-tight">Creatives</h1>
        {total > 0 && (
          <span className="text-[13px] tabular-nums text-muted-foreground/50">{total}</span>
        )}
      </div>

      {/* Filters + Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/40" />
          <input
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-full rounded-md bg-muted/40 pl-8 pr-3 text-[13px] outline-none placeholder:text-muted-foreground/30 focus:bg-muted/60 focus:ring-1 focus:ring-border transition-colors"
          />
        </div>
        <DateRangePicker
          from={fromDate}
          to={toDate}
          onChange={(range) => {
            if (range) {
              setFrom(formatDateOnly(range.from));
              setTo(formatDateOnly(range.to));
            }
          }}
        />
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
        {teamsQuery.data && teamsQuery.data.length > 0 && (
          <FilterPill
            value={teamId || "all"}
            onValueChange={(v) => setTeamId(v === "all" ? "" : v)}
            placeholder="Team"
            options={[
              { label: "All Teams", value: "all" },
              { label: "No Team", value: "none" },
              ...teamsQuery.data.map((t) => ({ label: t.name, value: t.id })),
            ]}
          />
        )}
        {adSetsQuery.data && adSetsQuery.data.length > 0 && (
          <AdSetCombobox
            value={adSetIds ? adSetIds.split(",").filter(Boolean) : []}
            onValueChange={(ids) => setAdSetIds(ids.length ? ids.join(",") : "")}
            adSets={adSetsQuery.data}
          />
        )}
        <FilterPill
          value={healthFilter || "all"}
          onValueChange={(v) => setHealthFilter(v === "all" ? "" : v)}
          placeholder="Health"
          options={[
            { label: "All Health", value: "all" },
            { label: "Healthy", value: "healthy" },
            { label: "Warning", value: "warning" },
            { label: "Critical", value: "critical" },
          ]}
        />
        <div className="flex-1" />
        <DataTableColumnToggle
          columns={tableColumns}
          visibility={columnVisibility}
          onVisibilityChange={setColumnVisibility}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="gap-1.5">
              <Download className="size-3.5" /> Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setExportOpen(true)}>
              Export…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {!isReadOnly ? (
          <Button size="sm" variant="outline" asChild className="gap-1.5">
            <Link href="/import"><Upload className="size-3.5" /> Import</Link>
          </Button>
        ) : null}
      </div>

      {!isReadOnly ? (
        <StaleDataBanner
          account={accountsQuery.data?.find((a) => a.id === accountId) ?? accountsQuery.data?.[0]}
        />
      ) : null}

      {/* Data Table */}
      {creatives.isLoading ? (
        <TableLoadingSkeleton />
      ) : total === 0 ? (
        <EmptyState
          hasFilters={!!format || !!awareness || !!search || !!adSetIds || !!healthFilter || !!teamId}
          onClear={() => { setFormat(null); setAwareness(null); setSearch(""); setAccountId(""); setAdSetIds(""); setTeamId(""); setHealthFilter(""); }}
          onImport={!isReadOnly ? () => router.push("/import") : undefined}
          readOnly={isReadOnly}
        />
      ) : (
        <DataTable
          columns={tableColumns}
          data={creativeRows as Creative[]}
          getRowId={(row) => row.id}
          onRowClick={(row) => router.push(`/creatives/${row.id}`)}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={setColumnVisibility}
          meta={{ metaAccountId, teams: Object.fromEntries((teamsQuery.data ?? []).map((t) => [t.id, t.name])) }}
        />
      )}

      {/* Floating action bar */}
      {!isReadOnly && selectedCreativeIds.length > 0 && (
        <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-2.5 shadow-lg">
            <span className="text-sm font-medium">{selectedCreativeIds.length} selected</span>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { setSelectedTeamValue(""); setTeamDialogOpen(true); }}>
              <UserCheck className="size-3.5" /> Update Team
            </Button>
            <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRowSelection({})}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <ExportPreviewDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        filters={{
          from: fromValue,
          to: toValue,
          format: format || undefined,
          awarenessLevel: awareness || undefined,
          search: search || undefined,
          accountId: accountId || undefined,
          adSetIds: adSetIds ? adSetIds.split(",") : undefined,
          teamId: teamId || undefined,
        }}
        filterLabels={exportFilterLabels}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${selectedCreativeIds.length} creative${selectedCreativeIds.length > 1 ? "s" : ""}`}
        description={`This will permanently delete ${selectedCreativeIds.length} creative${selectedCreativeIds.length > 1 ? "s" : ""}. This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={handleBulkDelete}
        loading={deleteMutation.isPending}
      />

      <Dialog open={teamDialogOpen} onOpenChange={setTeamDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Update Team</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Assign {selectedCreativeIds.length} creative{selectedCreativeIds.length > 1 ? "s" : ""} to a team.
          </p>
          <Select value={selectedTeamValue} onValueChange={setSelectedTeamValue}>
            <SelectTrigger>
              <SelectValue placeholder="Select a team" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {teamsQuery.data?.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setTeamDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleUpdateTeam} disabled={!selectedTeamValue || bulkTeamMutation.isPending}>
              {bulkTeamMutation.isPending ? "Updating..." : "Update"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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

function AdSetCombobox({
  value,
  onValueChange,
  adSets,
}: {
  value: string[];
  onValueChange: (v: string[]) => void;
  adSets: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);

  const toggle = (id: string) => {
    onValueChange(
      value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
    );
  };

  const label =
    value.length === 0
      ? "Ad Set"
      : value.length === 1
        ? adSets.find((a) => a.id === value[0])?.name ?? "1 ad set"
        : `${value.length} ad sets`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          className="h-8 w-auto gap-1 border-none bg-muted/40 px-3 text-[13px] shadow-none hover:bg-muted/60"
        >
          <span className="max-w-[200px] truncate">{label}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search ad sets..." className="h-8 text-[13px]" />
          <CommandList>
            <CommandEmpty>No ad sets found.</CommandEmpty>
            <CommandGroup>
              {value.length > 0 && (
                <CommandItem
                  value="__clear__"
                  onSelect={() => { onValueChange([]); setOpen(false); }}
                >
                  Clear selection
                </CommandItem>
              )}
              {adSets.map((a) => {
                const isSelected = value.includes(a.id);
                return (
                  <CommandItem
                    key={a.id}
                    value={a.name}
                    onSelect={() => toggle(a.id)}
                  >
                    <Check className={cn("mr-2 size-3.5", isSelected ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{a.name}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function EmptyState({
  hasFilters,
  onClear,
  onImport,
  readOnly,
}: {
  hasFilters: boolean;
  onClear: () => void;
  onImport?: () => void;
  readOnly: boolean;
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
            : readOnly
              ? "No creatives are available to view yet."
              : "Import your Meta Ads Manager report to get started."}
        </p>
      </div>
      {hasFilters ? (
        <Button size="sm" variant="ghost" onClick={onClear}>Clear filters</Button>
      ) : onImport ? (
        <Button size="sm" variant="outline" onClick={onImport} className="gap-1.5">
          <Upload className="size-3.5" /> Import Ads
        </Button>
      ) : null}
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
