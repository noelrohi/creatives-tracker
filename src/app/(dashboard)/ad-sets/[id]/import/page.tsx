"use client";

import { useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
import { ArrowLeft, Upload, FileSpreadsheet } from "lucide-react";
import {
  parseCSV,
  detectLevel,
  suggestMapping,
  applyMapping,
  type ColumnMapping,
  type ParsedCSV,
} from "@/lib/csv-parser";

const PERF_FIELDS: { key: keyof ColumnMapping; label: string; required?: boolean }[] = [
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

export default function ImportCSVPage() {
  const params = useParams();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const adSetId = params.id as string;

  const [step, setStep] = useState<"upload" | "map" | "preview">("upload");
  const [csvText, setCsvText] = useState("");
  const [parsed, setParsed] = useState<ParsedCSV | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({
    name: null,
    parentName: null,
    roas: null,
    cpa: null,
    ctr: null,
    conversionRate: null,
    spend: null,
    conversions: null,
    impressions: null,
    reach: null,
    frequency: null,
    cpm: null,
    qualityRanking: null,
    engagementRateRanking: null,
    conversionRateRanking: null,
    dateStart: null,
    dateEnd: null,
  });

  const bulkCreate = useMutation({
    ...trpc.performanceLog.bulkCreate.mutationOptions(),
    onSuccess: (data) => {
      toast.success(`Imported ${data.length} performance logs`);
      queryClient.invalidateQueries({
        queryKey: trpc.performanceLog.listByAdSet.queryKey({ adSetId }),
      });
      router.push(`/ad-sets/${adSetId}`);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const handleParse = useCallback(() => {
    if (!csvText.trim()) {
      toast.error("Please paste or upload CSV data");
      return;
    }
    const result = parseCSV(csvText);
    if (result.rows.length === 0) {
      toast.error("No data rows found in CSV");
      return;
    }
    setParsed(result);
    const level = detectLevel(result.headers);
    setMapping(suggestMapping(result.headers, level));
    setStep("map");
  }, [csvText]);

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        setCsvText(event.target?.result as string);
      };
      reader.readAsText(file);
    },
    [],
  );

  const handleImport = useCallback(() => {
    if (!parsed) return;
    if (!mapping.dateStart || !mapping.dateEnd) {
      toast.error("Date Start and Date End mappings are required");
      return;
    }
    const rows = applyMapping(parsed.rows, mapping);
    if (rows.length === 0) {
      toast.error("No valid rows after applying mapping");
      return;
    }
    bulkCreate.mutate({ adSetId, rows });
  }, [parsed, mapping, adSetId, bulkCreate]);

  const mappedPreview = parsed
    ? applyMapping(parsed.rows, mapping).slice(0, 10)
    : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href={`/ad-sets/${adSetId}`}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">
          Import from CSV
        </h1>
      </div>

      {step === "upload" && (
        <div className="flex flex-col gap-4 max-w-2xl">
          <p className="text-sm text-muted-foreground">
            Import performance logs into this ad set from a CSV file.
          </p>
          <div className="flex items-center gap-3">
            <label className="cursor-pointer">
              <input
                type="file"
                accept=".csv"
                className="hidden"
                onChange={handleFileUpload}
              />
              <span className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors">
                <Upload className="size-4" />
                Upload CSV
              </span>
            </label>
            <span className="text-sm text-muted-foreground">or paste below</span>
          </div>
          <Textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder="Paste CSV content here..."
            className="min-h-[200px] font-mono text-xs"
          />
          <div className="flex justify-end">
            <Button onClick={handleParse} disabled={!csvText.trim()}>
              <FileSpreadsheet className="mr-2 size-4" />
              Parse CSV
            </Button>
          </div>
        </div>
      )}

      {step === "map" && parsed && (
        <div className="flex flex-col gap-4 max-w-2xl">
          <p className="text-sm text-muted-foreground">
            Map CSV columns to performance log fields.
          </p>
          <div className="rounded-lg border divide-y">
            {PERF_FIELDS.map(({ key, label, required }) => (
              <div
                key={key}
                className="grid grid-cols-[140px_1fr] items-center gap-4 px-4 py-3"
              >
                <span className="text-sm font-medium">
                  {label}
                  {required && <span className="text-destructive ml-0.5">*</span>}
                </span>
                <Select
                  value={mapping[key] ?? "__none__"}
                  onValueChange={(value) =>
                    setMapping((prev) => ({
                      ...prev,
                      [key]: value === "__none__" ? null : value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select column..." />
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
            ))}
          </div>
          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep("upload")}>Back</Button>
            <Button
              onClick={() => setStep("preview")}
              disabled={!mapping.dateStart || !mapping.dateEnd}
            >
              Preview
            </Button>
          </div>
        </div>
      )}

      {step === "preview" && parsed && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Preview ({mappedPreview.length} of {applyMapping(parsed.rows, mapping).length} rows).
          </p>
          <div className="rounded-lg border overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date Range</TableHead>
                  <TableHead>ROAS</TableHead>
                  <TableHead>CPA</TableHead>
                  <TableHead>CTR</TableHead>
                  <TableHead>Conv Rate</TableHead>
                  <TableHead>Spend</TableHead>
                  <TableHead>Conversions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mappedPreview.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell>{row.dateStart} &mdash; {row.dateEnd}</TableCell>
                    <TableCell>{row.roas ?? "—"}</TableCell>
                    <TableCell>{row.cpa ? `$${row.cpa}` : "—"}</TableCell>
                    <TableCell>{row.ctr ? `${row.ctr}%` : "—"}</TableCell>
                    <TableCell>{row.conversionRate ? `${row.conversionRate}%` : "—"}</TableCell>
                    <TableCell>{row.spend ? `$${row.spend}` : "—"}</TableCell>
                    <TableCell>{row.conversions ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep("map")}>Back</Button>
            <Button onClick={handleImport} disabled={bulkCreate.isPending}>
              {bulkCreate.isPending
                ? "Importing..."
                : `Import ${applyMapping(parsed.rows, mapping).length} Rows`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
