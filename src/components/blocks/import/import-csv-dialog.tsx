"use client";

import { useState, useRef } from "react";
import { useForm, Controller } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
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
import { toast } from "sonner";
import {
  Upload,
  FileSpreadsheet,
  ChevronDown,
  ChevronUp,
  Check,
} from "@/components/icons";
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

const ALL_FIELDS: {
  key: keyof ColumnMapping;
  label: string;
  required?: boolean;
  labelByLevel?: Partial<Record<ImportLevel, string>>;
  hideForLevel?: ImportLevel[];
}[] = [
  {
    key: "name",
    label: "Name",
    labelByLevel: { campaign: "Campaign Name", ad_set: "Ad Set Name", ad: "Ad Name" },
  },
  {
    key: "parentName",
    label: "Parent",
    labelByLevel: { ad_set: "Campaign Name", ad: "Ad Set Name" },
    hideForLevel: ["campaign"],
  },
  { key: "roas", label: "ROAS" },
  { key: "cpa", label: "CPA" },
  { key: "ctr", label: "CTR" },
  { key: "conversionRate", label: "Conv Rate" },
  { key: "spend", label: "Spend" },
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
  { key: "delivery", label: "Delivery Status" },
  { key: "adId", label: "Ad ID" },
  { key: "campaignId", label: "Campaign ID" },
  { key: "adSetId", label: "Ad Set ID" },
  { key: "dateStart", label: "Date Start", required: true },
  { key: "dateEnd", label: "Date End", required: true },
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
    delivery: null,
    adId: null, campaignId: null, adSetId: null,
  };
}

export interface AccountOption {
  id: string;
  name: string;
  metaAccountId: string;
}

interface ImportCSVDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expectedLevel: ImportLevel;
  onImport: (rows: MappedRow[], accountId?: string) => void;
  importing?: boolean;
  accounts?: AccountOption[];
}

export function ImportCSVDialog({
  open,
  onOpenChange,
  expectedLevel,
  onImport,
  importing,
  accounts,
}: ImportCSVDialogProps) {
  const [parsed, setParsed] = useState<ParsedCSV | null>(null);
  const [detectedLevel, setDetectedLevel] = useState<ImportLevel>(expectedLevel);
  const [mapping, setMapping] = useState<ColumnMapping>(emptyMapping());
  const [skipZeroSpend, setSkipZeroSpend] = useState(true);
  const [showMapping, setShowMapping] = useState(false);
  const accountForm = useForm<{ accountId: string }>({
    defaultValues: { accountId: "" },
  });
  const [autoDetected, setAutoDetected] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function resetState() {
    setParsed(null);
    setMapping(emptyMapping());
    setDetectedLevel(expectedLevel);
    accountForm.reset({ accountId: "" });
    setShowMapping(false);
    setAutoDetected(false);
    setDragging(false);
    setFileName(null);
  }

  function handleClose(open: boolean) {
    if (!open) resetState();
    onOpenChange(open);
  }

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
      const suggestedMapping = suggestMapping(result.headers, detected);
      setMapping(suggestedMapping);
      if (isMetaReport(result.headers)) {
        setAutoDetected(true);
        setShowMapping(false);
      }
    };
    reader.readAsText(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.endsWith(".csv")) {
      processFile(file);
    } else {
      toast.error("Please drop a .csv file");
    }
  }

  function getFilteredRows(): MappedRow[] {
    if (!parsed) return [];
    let rows = applyMapping(parsed.rows, mapping);
    if (skipZeroSpend) {
      rows = rows.filter((r) => {
        // Keep if row has any meaningful metric
        const hasSpend = r.spend !== undefined && r.spend !== "0" && r.spend !== "0.00";
        const hasClicks = (r.linkClicks && r.linkClicks > 0) || (r.clicksAll && r.clicksAll > 0);
        const hasImpressions = r.impressions && r.impressions > 0;
        const hasConversions = r.conversions && r.conversions > 0;
        return hasSpend || hasClicks || hasImpressions || hasConversions;
      });
    }
    return rows;
  }

  function handleImport() {
    const accountId = accountForm.getValues("accountId");
    if (hasAccounts && !accountId) {
      accountForm.setError("accountId", { message: "Please select an account" });
      return;
    }
    const rows = getFilteredRows();
    if (rows.length === 0) {
      toast.error("No valid rows to import");
      return;
    }
    onImport(rows, accountId || undefined);
  }

  const filteredRows = getFilteredRows();
  const totalRows = filteredRows.length;
  const previewRows = filteredRows.slice(0, 50);
  const detectedCount = Object.values(mapping).filter(Boolean).length;
  const visibleFields = ALL_FIELDS.filter(
    (f) => !f.hideForLevel?.includes(detectedLevel),
  );
  const levelLabel = getLevelLabel(detectedLevel);
  const hasAccounts = accounts && accounts.length > 0;
  const selectedAccountId = accountForm.watch("accountId");
  const needsAccount = hasAccounts && !selectedAccountId;

  return (
    <Sheet open={open} onOpenChange={handleClose}>
      <SheetContent
        side="right"
        className="sm:max-w-2xl w-full flex flex-col"
      >
        <SheetHeader>
          <SheetTitle>Import CSV</SheetTitle>
          <SheetDescription>
            {parsed
              ? `${fileName} — ${parsed.rows.length} rows detected`
              : "Upload a Meta Ads Manager CSV export"}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto flex flex-col gap-5 px-4">
          {/* Drop zone — always visible so user can re-upload */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
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
              onChange={handleFileInput}
            />
            {parsed ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileSpreadsheet className="size-4" />
                <span>{fileName}</span>
                <Badge variant="outline" className="ml-1">{levelLabel}</Badge>
                <Check className="size-3.5 text-green-500" />
                <span className="text-xs text-muted-foreground/60">
                  Click to replace
                </span>
              </div>
            ) : (
              <>
                <div className="flex size-10 items-center justify-center rounded-full bg-muted/60">
                  <Upload className="size-4 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  Drop a CSV file here or click to browse
                </p>
                <p className="text-xs text-muted-foreground/50">
                  Supports campaigns, ad sets, and ads exports
                </p>
              </>
            )}
          </div>

          {/* Parsed content */}
          {parsed && (
            <>
              {/* Controls row */}
              <div className="flex items-center gap-3 flex-wrap">
                {autoDetected ? (
                  <Badge variant="default" className="text-xs">
                    Meta report auto-detected
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-xs">
                    {detectedCount} columns mapped
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={() => setShowMapping(!showMapping)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showMapping ? (
                    <ChevronUp className="size-3" />
                  ) : (
                    <ChevronDown className="size-3" />
                  )}
                  {showMapping ? "Hide" : "Edit"} column mapping
                </button>
                <div className="flex-1" />
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={skipZeroSpend}
                    onCheckedChange={(v) => setSkipZeroSpend(!!v)}
                  />
                  Skip empty rows
                </label>
              </div>

              {/* Collapsible mapping */}
              {showMapping && (
                <div className="rounded-lg border divide-y">
                  {visibleFields.map((field) => {
                    const label = field.labelByLevel?.[detectedLevel] ?? field.label;
                    const isMapped = !!mapping[field.key];
                    return (
                      <div
                        key={field.key}
                        className="grid grid-cols-[140px_1fr] items-center gap-3 px-3 py-2"
                      >
                        <span className={`text-sm ${isMapped ? "font-medium" : "text-muted-foreground"}`}>
                          {label}
                          {field.required && <span className="text-destructive ml-0.5">*</span>}
                        </span>
                        <Select
                          value={mapping[field.key] ?? "__none__"}
                          onValueChange={(value) =>
                            setMapping((prev) => ({
                              ...prev,
                              [field.key]: value === "__none__" ? null : value,
                            }))
                          }
                        >
                          <SelectTrigger className="h-7 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">— None —</SelectItem>
                            {parsed.headers.map((header) => (
                              <SelectItem key={header} value={header}>
                                {header}
                              </SelectItem>
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
                <Controller
                  control={accountForm.control}
                  name="accountId"
                  rules={{ required: "Please select an account" }}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel>Account</FieldLabel>
                      <Select
                        value={field.value}
                        onValueChange={(v) => {
                          field.onChange(v);
                          accountForm.clearErrors("accountId");
                        }}
                      >
                        <SelectTrigger className="h-8" aria-invalid={fieldState.invalid}>
                          <SelectValue placeholder="Select account..." />
                        </SelectTrigger>
                        <SelectContent>
                          {accounts!.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.name}
                              <span className="ml-2 text-xs text-muted-foreground">
                                ({a.metaAccountId})
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {fieldState.error && (
                        <FieldError errors={[fieldState.error]} />
                      )}
                    </Field>
                  )}
                />
              )}

              {/* Preview table */}
              <div className="rounded-lg border overflow-auto flex-1">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="sticky top-0 bg-background">Name</TableHead>
                      {detectedLevel !== "campaign" && (
                        <TableHead className="sticky top-0 bg-background">
                          {detectedLevel === "ad" ? "Ad Set" : "Campaign"}
                        </TableHead>
                      )}
                      <TableHead className="sticky top-0 bg-background">Dates</TableHead>
                      <TableHead className="sticky top-0 bg-background">Spend</TableHead>
                      <TableHead className="sticky top-0 bg-background">ROAS</TableHead>
                      <TableHead className="sticky top-0 bg-background">CPA</TableHead>
                      <TableHead className="sticky top-0 bg-background">Conv</TableHead>
                      <TableHead className="sticky top-0 bg-background">Impr</TableHead>
                      <TableHead className="sticky top-0 bg-background">Reach</TableHead>
                      <TableHead className="sticky top-0 bg-background">CPM</TableHead>
                      <TableHead className="sticky top-0 bg-background">Clicks</TableHead>
                      <TableHead className="sticky top-0 bg-background">LPV</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewRows.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={detectedLevel !== "campaign" ? 12 : 11}
                          className="text-center text-muted-foreground py-8"
                        >
                          No rows match current filters.
                        </TableCell>
                      </TableRow>
                    ) : (
                      previewRows.map((row, i) => (
                        <TableRow key={i}>
                          <TableCell className="max-w-[200px] truncate font-medium">
                            {row.name || "—"}
                          </TableCell>
                          {detectedLevel !== "campaign" && (
                            <TableCell className="max-w-[140px] truncate text-muted-foreground">
                              {row.parentName || "—"}
                            </TableCell>
                          )}
                          <TableCell className="whitespace-nowrap text-xs tabular-nums">
                            {row.dateStart} — {row.dateEnd}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {row.spend ? `$${row.spend}` : "—"}
                          </TableCell>
                          <TableCell className="tabular-nums">{row.roas ?? "—"}</TableCell>
                          <TableCell className="tabular-nums">
                            {row.cpa ? `$${row.cpa}` : "—"}
                          </TableCell>
                          <TableCell className="tabular-nums">{row.conversions ?? "—"}</TableCell>
                          <TableCell className="tabular-nums">
                            {row.impressions?.toLocaleString() ?? "—"}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {row.reach?.toLocaleString() ?? "—"}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {row.cpm ? `$${row.cpm}` : "—"}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {row.linkClicks?.toLocaleString() ?? "—"}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {row.landingPageViews?.toLocaleString() ?? "—"}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>

            </>
          )}
        </div>

        {/* Footer — outside scroll area so it's always clickable */}
        {parsed && (
          <SheetFooter className="flex-row items-center justify-between border-t">
            <p className="text-sm text-muted-foreground tabular-nums">
              {totalRows} row{totalRows !== 1 ? "s" : ""}
              {previewRows.length < totalRows
                ? ` (showing ${previewRows.length})`
                : ""}
            </p>
            <Button
              type="button"
              onClick={() => handleImport()}
              disabled={importing || totalRows === 0 || needsAccount}
            >
              {importing
                ? "Importing..."
                : `Import ${totalRows} row${totalRows !== 1 ? "s" : ""}`}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
