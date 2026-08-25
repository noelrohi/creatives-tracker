"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowUpDown, Copy, ExternalLink, ImageIcon, MoreHorizontal, Sparkles, Video } from "@/components/icons";
import { parseDateOnly } from "@/lib/date";
import { getUtmParams } from "@/lib/utm-params";
import { useTRPC } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import type { CreativeHealth } from "@/lib/creative-health";
import type { Creative } from "./creative-list-types";

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
    date: date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    time: date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
}

function NameListCell({ names, count }: { names: string[]; count: number }) {
  if (names.length === 0) return <span className="text-muted-foreground/30">&mdash;</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex max-w-[160px] items-center gap-1.5 text-sm text-muted-foreground">
          <span className="truncate">{names[0]}</span>
          {count > 1 && (
            <Badge variant="secondary" className="shrink-0 text-[10px] tabular-nums">
              +{count - 1}
            </Badge>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="space-y-0.5">
          {names.map((name) => (
            <div key={name}>{name}</div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function UtmTrackingCell({ creative }: { creative: Creative }) {
  const params = getUtmParams(creative.destinationUrl, creative.urlTags);
  if (params.length === 0) {
    return <span className="text-muted-foreground/30">&mdash;</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="secondary"
          className="cursor-default border-emerald-500/20 bg-emerald-500/10 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
        >
          Set · {params.length}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-sm p-3">
        <div className="space-y-2">
          {params.map(({ key, value }) => (
            <div key={key} className="grid grid-cols-[auto_1fr] gap-3 text-xs">
              <span className="font-medium text-background/70">{key}</span>
              <span className="break-all font-mono font-medium text-background">{value}</span>
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
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

export const creativeColumns: ColumnDef<Creative>[] = [
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
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block max-w-[260px] truncate font-medium">{row.getValue("name")}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-sm break-all">
          {row.getValue("name")}
        </TooltipContent>
      </Tooltip>
    ),
  },
  {
    accessorKey: "campaignNames",
    header: "Campaign",
    cell: ({ row }) => (
      <NameListCell names={row.original.campaignNames} count={row.original.campaignCount} />
    ),
    enableSorting: false,
  },
  {
    accessorKey: "adSetNames",
    header: "Ad Set",
    cell: ({ row }) => (
      <NameListCell names={row.original.adSetNames} count={row.original.adSetCount} />
    ),
    enableSorting: false,
  },
  {
    accessorKey: "adCount",
    header: ({ column }) => (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        Ads
        <ArrowUpDown className="ml-1.5 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => {
      const count = row.original.adCount;
      return (
        <Badge variant="secondary" className="text-[10px] tabular-nums text-muted-foreground">
          {count === 1 ? "1 ad" : `${count} ads`}
        </Badge>
      );
    },
    size: 80,
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
    id: "utmTracking",
    accessorFn: (row) => (
      getUtmParams(row.destinationUrl, row.urlTags).length > 0 ? 1 : 0
    ),
    header: ({ column }) => (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        UTM Tracking
        <ArrowUpDown className="ml-1.5 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => <UtmTrackingCell creative={row.original} />,
    sortDescFirst: false,
    size: 125,
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
    accessorKey: "firstSeen",
    header: ({ column }) => (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        First Seen
        <ArrowUpDown className="ml-1.5 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => {
      const firstSeen = row.original.firstSeen;
      if (!firstSeen) return <span className="text-muted-foreground/30">—</span>;
      return <span className="text-sm tabular-nums">{formatDateTime(parseDateOnly(firstSeen)).date}</span>;
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
    cell: ({ row }) => <CreativeActionsCell creative={row.original} />,
    enableSorting: false,
    enableHiding: false,
    size: 40,
  },
];

function CreativeActionsCell({ creative }: { creative: Creative }) {
  const trpc = useTRPC();
  // Shares the sidebar's query, so this costs no extra request.
  const { data: featureFlags } = useQuery(
    trpc.orgSettings.getFeatureFlags.queryOptions(),
  );
  const imageStudioEnabled = featureFlags?.imageStudio ?? false;
  const metaAdId = creative.metaAdId;
  const metaCampaignId = creative.metaCampaignId;
  const metaAdSetId = creative.metaAdSetId;

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
        {imageStudioEnabled && (
          <DropdownMenuItem asChild>
            <Link href={`/studio?remix=${creative.id}`}>
              <Sparkles className="size-3.5" />
              Remix in Studio
            </Link>
          </DropdownMenuItem>
        )}
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
}
