"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC, useTRPCClient } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Upload, FileSpreadsheet, Check, ChevronDown, ChevronUp } from "@/components/icons";
import { toast } from "sonner";
import { getUserFacingErrorMessage } from "@/lib/errors";
import {
  parseCSV,
  detectLevel,
  getLevelLabel,
  suggestMapping,
  applyMapping,
  isMetaReport,
  type ColumnMapping,
  type ParsedCSV,
  type MappedRow,
  type ImportLevel,
} from "@/lib/csv-parser";
import {
  mapRowsForImport,
  splitBulkImportRows,
  type BulkImportRow,
} from "@/lib/import-utils";
import { NoAccountsState } from "./no-accounts-state";

export interface CsvImportTabProps {
  accounts: { id: string; name: string; metaAccountId: string; hasMetaAccessToken: boolean; lastImportedAt: Date | null; dataDateEnd: string | null }[];
  selectedAccountId: string | null;
  onSelectAccount: (id: string) => void;
  onRequestCreateAccount: () => void;
}

const ALL_FIELDS: {
  key: keyof ColumnMapping;
  label: string;
  required?: boolean;
  labelByLevel?: Partial<Record<ImportLevel, string>>;
  hideForLevel?: ImportLevel[];
}[] = [
  { key: "name", label: "Ad Name", required: true },
  { key: "adId", label: "Ad ID", required: true },
  { key: "campaignName", label: "Campaign Name", required: true },
  { key: "adSetName", label: "Ad Set Name", required: true },
  { key: "delivery", label: "Delivery Status", required: true },
  { key: "spend", label: "Spend", required: true },
  { key: "dateStart", label: "Date Start", required: true },
  { key: "dateEnd", label: "Date End", required: true },
  { key: "parentName", label: "Parent", labelByLevel: { ad_set: "Campaign Name", ad: "Ad Set Name" }, hideForLevel: ["campaign"] },
  { key: "roas", label: "ROAS" },
  { key: "cpa", label: "CPA" },
  { key: "ctr", label: "CTR" },
  { key: "conversionRate", label: "Conv Rate" },
  { key: "conversions", label: "Conversions" },
  { key: "impressions", label: "Impressions" },
  { key: "reach", label: "Reach" },
  { key: "frequency", label: "Frequency" },
  { key: "cpm", label: "CPM" },
  { key: "qualityRanking", label: "Quality Ranking" },
  { key: "engagementRateRanking", label: "Engagement Ranking" },
  { key: "conversionRateRanking", label: "Conversion Ranking" },
  { key: "linkClicks", label: "Link Clicks" },
  { key: "clicksAll", label: "Clicks (all)" },
  { key: "cpc", label: "CPC" },
  { key: "ctrLinkClick", label: "CTR (link click)" },
  { key: "landingPageViews", label: "LP Views" },
  { key: "costPerLpv", label: "Cost per LPV" },
  { key: "purchaseValue", label: "Purchase Value" },
  { key: "addToCart", label: "Add to Cart" },
  { key: "initiateCheckout", label: "Initiate Checkout" },
  { key: "costPerAddToCart", label: "Cost per ATC" },
  { key: "videoViews3s", label: "3s Video Views" },
  { key: "videoThruplay", label: "ThruPlays" },
  { key: "videoAvgWatchTime", label: "Avg Watch Time" },
  { key: "country", label: "Country" },
  { key: "platform", label: "Platform" },
  { key: "placement", label: "Placement" },
  { key: "device", label: "Device" },
  { key: "age", label: "Age" },
  { key: "gender", label: "Gender" },
  { key: "campaignId", label: "Campaign ID" },
  { key: "adSetId", label: "Ad Set ID" },
];

function emptyMapping(): ColumnMapping {
  return {
    name: null, parentName: null, campaignName: null, adSetName: null,
    roas: null, cpa: null, ctr: null,
    conversionRate: null, spend: null, conversions: null, impressions: null,
    reach: null, frequency: null, cpm: null, qualityRanking: null,
    engagementRateRanking: null, conversionRateRanking: null,
    dateStart: null, dateEnd: null,
    linkClicks: null, clicksAll: null, cpc: null, ctrLinkClick: null,
    landingPageViews: null, costPerLpv: null, purchaseValue: null,
    addToCart: null, initiateCheckout: null, costPerAddToCart: null,
    videoViews3s: null, videoThruplay: null, videoAvgWatchTime: null,
    country: null, platform: null, placement: null,
    device: null, age: null, gender: null,
    delivery: null, adId: null, campaignId: null, adSetId: null,
  };
}

export function CsvImportTab({
  accounts,
  selectedAccountId,
  onSelectAccount,
  onRequestCreateAccount,
}: CsvImportTabProps) {
  const router = useRouter();
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [parsed, setParsed] = useState<ParsedCSV | null>(null);
  const [detectedLevel, setDetectedLevel] = useState<ImportLevel>("ad");
  const [mapping, setMapping] = useState<ColumnMapping>(emptyMapping());
  const [skipEmpty, setSkipEmpty] = useState(true);
  const [showMapping, setShowMapping] = useState(false);
  const [autoDetected, setAutoDetected] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [mountedAt] = useState(() => Date.now());

  const importMutation = useMutation({
    mutationKey: trpc.adCreative.bulkImport.mutationKey(),
    mutationFn: async ({
      accountId,
      rows,
    }: {
      accountId?: string;
      rows: BulkImportRow[];
    }) => {
      const rowChunks = splitBulkImportRows(rows, accountId);
      const createdById = new Map<string, { id: string; name: string }>();
      let perfLogs = 0;

      for (const rowChunk of rowChunks) {
        const result = await trpcClient.adCreative.bulkImport.mutate({
          accountId,
          rows: rowChunk,
        });

        for (const created of result.created) {
          createdById.set(created.id, created);
        }

        perfLogs += result.perfLogs;
      }

      return {
        created: [...createdById.values()],
        totalRows: rows.length,
        uniqueAds: new Set(rows.map((row) => row.adId || row.name)).size,
        perfLogs,
      };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: trpc.adCreative.list.queryKey() });
      queryClient.invalidateQueries({ queryKey: trpc.ad.list.queryKey() });
      const newCount = data.created.length;
      const updatedCount = data.uniqueAds - newCount;
      const parts = [];
      if (newCount > 0) parts.push(`${newCount} new`);
      if (updatedCount > 0) parts.push(`${updatedCount} updated`);
      toast.success(`${parts.join(", ")} ad${data.uniqueAds > 1 ? "s" : ""} · ${data.perfLogs.toLocaleString()} perf rows`);
      router.push("/creatives");
    },
    onError: (error) =>
      toast.error(getUserFacingErrorMessage(error, "Import failed.")),
  });

  function processFile(file: File) {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const result = parseCSV(text);
      if (result.rows.length === 0) {
        toast.error("No data rows found in CSV");
        return;
      }
      setParsed(result);
      const detected = detectLevel(result.headers);
      setDetectedLevel(detected);
      setMapping(suggestMapping(result.headers, detected));
      if (isMetaReport(result.headers)) {
        setAutoDetected(true);
        setShowMapping(false);
      }
    };
    reader.readAsText(file);
  }

  function getFilteredRows(): MappedRow[] {
    if (!parsed) return [];
    let rows = applyMapping(parsed.rows, mapping);
    if (skipEmpty) {
      rows = rows.filter((r) => {
        const hasSpend = r.spend !== undefined && r.spend !== "0" && r.spend !== "0.00";
        const hasClicks = (r.linkClicks && r.linkClicks > 0) || (r.clicksAll && r.clicksAll > 0);
        const hasImpressions = r.impressions && r.impressions > 0;
        const hasConversions = r.conversions && r.conversions > 0;
        return hasSpend || hasClicks || hasImpressions || hasConversions;
      });
    }
    return rows;
  }

  const requiredFields = ALL_FIELDS.filter((f) => f.required);
  const missingRequired = requiredFields.filter((f) => !mapping[f.key]);

  function handleImport() {
    if (accounts.length > 0 && !selectedAccountId) {
      setAccountError("Please select an account");
      return;
    }
    if (missingRequired.length > 0) {
      toast.error(`Missing required columns: ${missingRequired.map((f) => f.label).join(", ")}`);
      setShowMapping(true);
      return;
    }
    const rows = getFilteredRows();
    if (rows.length === 0) {
      toast.error("No valid rows to import");
      return;
    }
    importMutation.mutate({
      accountId: selectedAccountId || undefined,
      rows: mapRowsForImport(rows),
    });
  }

  if (accounts.length === 0) {
    return <NoAccountsState onCreateAccount={onRequestCreateAccount} />;
  }

  const filteredRows = getFilteredRows();
  const totalRows = filteredRows.length;
  const previewRows = filteredRows.slice(0, 50);
  const detectedCount = Object.values(mapping).filter(Boolean).length;
  const visibleFields = ALL_FIELDS.filter(
    (f) => !f.hideForLevel?.includes(detectedLevel),
  );
  const levelLabel = getLevelLabel(detectedLevel);
  const hasAccounts = accounts.length > 0;
  const needsAccount = hasAccounts && !selectedAccountId;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Import Ads</h1>
        <p className="text-sm text-muted-foreground">
          Upload a Meta Ads Manager report to import ads with performance data.
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file && file.name.endsWith(".csv")) processFile(file);
          else toast.error("Please drop a .csv file");
        }}
        onClick={() => fileInputRef.current?.click()}
        className={`
          flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed
          cursor-pointer transition-colors
          ${parsed ? "py-4" : "py-12"}
          ${dragging
            ? "border-primary bg-primary/5"
            : parsed
              ? "border-border/50 hover:border-border"
              : "border-border hover:border-primary/50 hover:bg-muted/30"
          }
        `}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) processFile(file);
          }}
        />
        {parsed ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <FileSpreadsheet className="size-4" />
            <span>{fileName}</span>
            <Badge variant="outline" className="ml-1">{levelLabel}</Badge>
            <Check className="size-3.5 text-green-500" />
            <span className="text-xs text-muted-foreground/60">Click to replace</span>
          </div>
        ) : (
          <>
            <div className="flex size-10 items-center justify-center rounded-full bg-muted/60">
              <Upload className="size-4 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">Drop a CSV file here or click to browse</p>
            <p className="text-xs text-muted-foreground/50">Supports Meta Ads Manager exports with breakdowns</p>
          </>
        )}
      </div>

      {/* Parsed content */}
      {parsed && (
        <>
          {/* Controls */}
          {/* Missing columns warning */}
          {missingRequired.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-red-500/30 bg-red-500/5 px-4 py-3">
              <p className="text-sm text-red-500">
                Missing required columns: <span className="font-medium">{missingRequired.map((f) => f.label).join(", ")}</span>
              </p>
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap">
            {autoDetected ? (
              <Badge variant="default" className="text-xs">Meta report auto-detected</Badge>
            ) : (
              <Badge variant="secondary" className="text-xs">{detectedCount} columns mapped</Badge>
            )}
            <button
              type="button"
              onClick={() => setShowMapping(!showMapping)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {showMapping ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              {showMapping ? "Hide" : "Edit"} column mapping
            </button>
            <div className="flex-1" />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={skipEmpty} onCheckedChange={(v) => setSkipEmpty(!!v)} />
              Skip empty rows
            </label>
          </div>

          {/* Column mapping */}
          {showMapping && (
            <div className="rounded-lg border divide-y max-h-80 overflow-y-auto">
              {visibleFields.map((field) => {
                const label = field.labelByLevel?.[detectedLevel] ?? field.label;
                const isMapped = !!mapping[field.key];
                const isMissing = field.required && !isMapped;
                return (
                  <div key={field.key} className={`grid grid-cols-[140px_1fr] items-center gap-3 px-3 py-2 ${isMissing ? "bg-red-500/5" : ""}`}>
                    <span className={`text-sm ${isMissing ? "text-red-500 font-medium" : isMapped ? "font-medium" : "text-muted-foreground"}`}>
                      {label}
                      {field.required && <span className="text-destructive ml-0.5">*</span>}
                    </span>
                    <Select
                      value={mapping[field.key] ?? "__none__"}
                      onValueChange={(value) =>
                        setMapping((prev) => ({ ...prev, [field.key]: value === "__none__" ? null : value }))
                      }
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">— None —</SelectItem>
                        {parsed.headers.map((header) => (
                          <SelectItem key={header} value={header}>{header}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          )}

          {/* Account selector */}
          {hasAccounts && (
            <Field data-invalid={!!accountError}>
              <FieldLabel>Account</FieldLabel>
              <Select
                value={selectedAccountId ?? ""}
                onValueChange={(v) => { onSelectAccount(v); setAccountError(null); }}
              >
                <SelectTrigger className="h-9 max-w-sm" aria-invalid={!!accountError}>
                  <SelectValue placeholder="Select account..." />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      <span className="ml-2 text-xs text-muted-foreground">({a.metaAccountId})</span>
                      {a.dataDateEnd && (
                        <span className="ml-2 text-xs text-muted-foreground/60">
                          · data thru {a.dataDateEnd}
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {accountError && <FieldError errors={[{ message: accountError }]} />}
            </Field>
          )}

          {/* Data freshness */}
          {selectedAccountId && (() => {
            const account = accounts.find((a) => a.id === selectedAccountId);
            if (!account?.lastImportedAt) return null;
            const daysAgo = Math.floor((mountedAt - new Date(account.lastImportedAt).getTime()) / 86400000);
            const stale = daysAgo >= 3;
            return (
              <div className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${stale ? "border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400" : "border-border/50 text-muted-foreground"}`}>
                <span className={`size-1.5 rounded-full ${stale ? "bg-amber-500" : "bg-green-500"}`} />
                Last import {daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo}d ago`}
                {account.dataDateEnd && <span>· data through {account.dataDateEnd}</span>}
              </div>
            );
          })()}

          {/* Preview table */}
          <div className="rounded-lg border overflow-auto max-h-[50vh]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky top-0 bg-background">Name</TableHead>
                  {mapping.age && <TableHead className="sticky top-0 bg-background">Age</TableHead>}
                  {mapping.gender && <TableHead className="sticky top-0 bg-background">Gender</TableHead>}
                  {mapping.country && <TableHead className="sticky top-0 bg-background">Country</TableHead>}
                  {mapping.platform && <TableHead className="sticky top-0 bg-background">Platform</TableHead>}
                  <TableHead className="sticky top-0 bg-background">Dates</TableHead>
                  <TableHead className="sticky top-0 bg-background">Spend</TableHead>
                  <TableHead className="sticky top-0 bg-background">ROAS</TableHead>
                  <TableHead className="sticky top-0 bg-background">Conv</TableHead>
                  <TableHead className="sticky top-0 bg-background">Impr</TableHead>
                  <TableHead className="sticky top-0 bg-background">Clicks</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {previewRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                      No rows match current filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  previewRows.map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="max-w-[200px] truncate font-medium">{row.name || "—"}</TableCell>
                      {mapping.age && <TableCell className="text-sm">{row.age || "—"}</TableCell>}
                      {mapping.gender && <TableCell className="text-sm capitalize">{row.gender || "—"}</TableCell>}
                      {mapping.country && <TableCell className="text-sm">{row.country || "—"}</TableCell>}
                      {mapping.platform && <TableCell className="text-sm">{row.platform || "—"}</TableCell>}
                      <TableCell className="whitespace-nowrap text-xs tabular-nums">
                        {row.dateStart}{row.dateStart !== row.dateEnd ? ` — ${row.dateEnd}` : ""}
                      </TableCell>
                      <TableCell className="tabular-nums">{row.spend ? `$${row.spend}` : "—"}</TableCell>
                      <TableCell className="tabular-nums">{row.roas ?? "—"}</TableCell>
                      <TableCell className="tabular-nums">{row.conversions ?? "—"}</TableCell>
                      <TableCell className="tabular-nums">{row.impressions?.toLocaleString() ?? "—"}</TableCell>
                      <TableCell className="tabular-nums">{row.linkClicks?.toLocaleString() ?? "—"}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground tabular-nums">
              {totalRows} row{totalRows !== 1 ? "s" : ""}
              {previewRows.length < totalRows ? ` (showing ${previewRows.length})` : ""}
            </p>
            <Button
              onClick={handleImport}
              disabled={importMutation.isPending || totalRows === 0 || needsAccount || missingRequired.length > 0}
            >
              {importMutation.isPending
                ? "Importing..."
                : `Import ${totalRows} row${totalRows !== 1 ? "s" : ""}`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
