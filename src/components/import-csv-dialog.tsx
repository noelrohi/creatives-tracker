"use client";

import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
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
} from "lucide-react";
import {
  parseCSV,
  detectLevel,
  getLevelLabel,
  suggestMapping,
  applyMapping,
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
  { key: "dateStart", label: "Date Start", required: true },
  { key: "dateEnd", label: "Date End", required: true },
];

function emptyMapping(): ColumnMapping {
  return {
    name: null, parentName: null, roas: null, cpa: null, ctr: null,
    conversionRate: null, spend: null, conversions: null, impressions: null,
    reach: null, frequency: null, cpm: null, qualityRanking: null,
    engagementRateRanking: null, conversionRateRanking: null,
    dateStart: null, dateEnd: null,
  };
}

export interface ParentOption {
  id: string;
  name: string;
}

interface ImportCSVDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expectedLevel: ImportLevel;
  onImport: (rows: MappedRow[], parentId: string | null) => void;
  importing?: boolean;
  parentOptions?: ParentOption[];
  parentLabel?: string;
}

export function ImportCSVDialog({
  open,
  onOpenChange,
  expectedLevel,
  onImport,
  importing,
  parentOptions,
  parentLabel,
}: ImportCSVDialogProps) {
  const [parsed, setParsed] = useState<ParsedCSV | null>(null);
  const [detectedLevel, setDetectedLevel] = useState<ImportLevel>(expectedLevel);
  const [mapping, setMapping] = useState<ColumnMapping>(emptyMapping());
  const [skipZeroSpend, setSkipZeroSpend] = useState(true);
  const [selectedParentId, setSelectedParentId] = useState<string | null>(null);
  const [showMapping, setShowMapping] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetState = useCallback(() => {
    setParsed(null);
    setMapping(emptyMapping());
    setDetectedLevel(expectedLevel);
    setSelectedParentId(null);
    setShowMapping(false);
    setDragging(false);
    setFileName(null);
  }, [expectedLevel]);

  const handleClose = useCallback(
    (open: boolean) => {
      if (!open) resetState();
      onOpenChange(open);
    },
    [onOpenChange, resetState],
  );

  const processFile = useCallback(
    (file: File) => {
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
      };
      reader.readAsText(file);
    },
    [],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file && file.name.endsWith(".csv")) {
        processFile(file);
      } else {
        toast.error("Please drop a .csv file");
      }
    },
    [processFile],
  );

  const getFilteredRows = useCallback((): MappedRow[] => {
    if (!parsed) return [];
    let rows = applyMapping(parsed.rows, mapping);
    if (skipZeroSpend) {
      rows = rows.filter(
        (r) => r.spend !== undefined && r.spend !== "0" && r.spend !== "0.00",
      );
    }
    return rows;
  }, [parsed, mapping, skipZeroSpend]);

  const handleImport = useCallback(() => {
    if (!mapping.dateStart || !mapping.dateEnd) {
      toast.error("Date Start and Date End are required");
      return;
    }
    const rows = getFilteredRows();
    if (rows.length === 0) {
      toast.error("No valid rows to import");
      return;
    }
    onImport(rows, selectedParentId);
  }, [mapping, getFilteredRows, onImport, selectedParentId]);

  const filteredRows = getFilteredRows();
  const totalRows = filteredRows.length;
  const previewRows = filteredRows.slice(0, 50);
  const detectedCount = Object.values(mapping).filter(Boolean).length;
  const visibleFields = ALL_FIELDS.filter(
    (f) => !f.hideForLevel?.includes(detectedLevel),
  );
  const levelLabel = getLevelLabel(detectedLevel);
  const hasParentColumn = !!mapping.parentName;

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

        <div className="flex-1 overflow-y-auto flex flex-col gap-5 px-4 pb-4">
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
                <Badge variant="secondary" className="text-xs">
                  {detectedCount} columns mapped
                </Badge>
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
                  Skip $0 spend
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

              {/* Parent selector */}
              {parentOptions && parentOptions.length > 0 && !hasParentColumn && (
                <div className="flex items-center gap-3 rounded-lg border px-4 py-3">
                  <span className="text-sm font-medium shrink-0">
                    {parentLabel || "Link to"}
                  </span>
                  <Select
                    value={selectedParentId ?? "__none__"}
                    onValueChange={(v) =>
                      setSelectedParentId(v === "__none__" ? null : v)
                    }
                  >
                    <SelectTrigger className="h-8 flex-1">
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— None —</SelectItem>
                      {parentOptions.map((opt) => (
                        <SelectItem key={opt.id} value={opt.id}>
                          {opt.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
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
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewRows.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={detectedLevel !== "campaign" ? 10 : 9}
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
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between pt-1">
                <p className="text-sm text-muted-foreground tabular-nums">
                  {totalRows} row{totalRows !== 1 ? "s" : ""}
                  {previewRows.length < totalRows
                    ? ` (showing ${previewRows.length})`
                    : ""}
                </p>
                <Button
                  onClick={handleImport}
                  disabled={importing || totalRows === 0}
                >
                  {importing
                    ? "Importing..."
                    : `Import ${totalRows} row${totalRows !== 1 ? "s" : ""}`}
                </Button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
