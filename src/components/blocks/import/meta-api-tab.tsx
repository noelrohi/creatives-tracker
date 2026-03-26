"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { format, parse } from "date-fns";
import { useTRPC, useTRPCClient } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateRangePicker } from "@/components/blocks/dashboard/date-range-picker";
import { Loader2, CloudDownload, Key, CirclePlus, Check } from "lucide-react";
import { toast } from "sonner";
import { mapRowsForImport, splitBulkImportRows } from "@/lib/import-utils";
import type { MappedRow } from "@/lib/csv-parser";

const fetchSchema = z.object({
  accountId: z.string().min(1, "Select an account."),
});

type FetchValues = z.infer<typeof fetchSchema>;

type SyncPhase = "idle" | "requesting" | "processing" | "downloading" | "importing" | "done";

function formatDateOnly(date: Date) {
  return format(date, "yyyy-MM-dd");
}

function parseDateOnly(value: string) {
  return parse(value, "yyyy-MM-dd", new Date());
}

interface MetaApiTabProps {
  accounts: {
    id: string;
    name: string;
    metaAccountId: string;
    hasMetaAccessToken: boolean;
  }[];
  onRequestCreateAccount: () => void;
}

export function MetaApiTab({
  accounts,
  onRequestCreateAccount,
}: MetaApiTabProps) {
  const router = useRouter();
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  const apiAccounts = accounts.filter((a) => a.hasMetaAccessToken);

  const [dateFrom, setDateFrom] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return formatDateOnly(d);
  });
  const [dateTo, setDateTo] = useState<string>(
    () => formatDateOnly(new Date()),
  );
  // Breakdowns removed — Meta restricts combining them with action fields.
  // Use CSV import for breakdown-level data.
  const [phase, setPhase] = useState<SyncPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [fetchedRows, setFetchedRows] = useState<MappedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const form = useForm<FetchValues>({
    resolver: zodResolver(fetchSchema),
    defaultValues: { accountId: "" },
  });

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function handleSync(data: FetchValues) {
    setError(null);
    setFetchedRows(null);
    setProgress(0);

    try {
      // Step 1: Request async report
      setPhase("requesting");
      const { reportRunId } = await trpcClient.metaInsights.requestReport.mutate({
        accountId: data.accountId,
        dateFrom,
        dateTo,
        level: "ad",
      });

      // Step 2: Poll for completion
      setPhase("processing");
      await new Promise<void>((resolve, reject) => {
        pollRef.current = setInterval(async () => {
          try {
            const status = await trpcClient.metaInsights.checkReport.query({
              reportRunId,
              accountId: data.accountId,
            });

            setProgress(status.percentComplete);

            if (status.isFailed) {
              if (pollRef.current) clearInterval(pollRef.current);
              reject(new Error("Report generation failed on Meta's side."));
            }

            if (status.isComplete) {
              if (pollRef.current) clearInterval(pollRef.current);
              resolve();
            }
          } catch (err) {
            if (pollRef.current) clearInterval(pollRef.current);
            reject(err);
          }
        }, 3000);
      });

      // Step 3: Download report data
      setPhase("downloading");
      const { rows, totalRows } = await trpcClient.metaInsights.downloadReport.mutate({
        reportRunId,
        accountId: data.accountId,
        level: "ad",
      });

      if (totalRows === 0) {
        toast.info("No data found for the selected date range.");
        setPhase("idle");
        return;
      }

      setFetchedRows(rows);

      // Step 4: Auto-import
      setPhase("importing");
      const mapped = mapRowsForImport(rows);
      const chunks = splitBulkImportRows(mapped, data.accountId);
      let totalPerfLogs = 0;
      const createdById = new Map<string, { id: string; name: string }>();

      for (const chunk of chunks) {
        const result = await trpcClient.adCreative.bulkImport.mutate({
          accountId: data.accountId,
          rows: chunk,
        });
        for (const c of result.created) {
          createdById.set(c.id, c);
        }
        totalPerfLogs += result.perfLogs;
      }

      // Done
      setPhase("done");
      queryClient.invalidateQueries({ queryKey: trpc.adCreative.list.queryKey() });
      queryClient.invalidateQueries({ queryKey: trpc.ad.list.queryKey() });

      const uniqueAds = new Set(rows.map((r) => r.adId || r.name)).size;
      const newCount = createdById.size;
      const updatedCount = uniqueAds - newCount;
      const parts = [];
      if (newCount > 0) parts.push(`${newCount} new`);
      if (updatedCount > 0) parts.push(`${updatedCount} updated`);
      toast.success(
        `${parts.join(", ")} ad${uniqueAds > 1 ? "s" : ""} · ${totalPerfLogs.toLocaleString()} perf rows`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
      setPhase("idle");
    }
  }

  const isSyncing = phase !== "idle" && phase !== "done";

  // No accounts with tokens
  if (apiAccounts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
        <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-muted">
          <Key className="size-5 text-muted-foreground" />
        </div>
        <h3 className="text-sm font-medium">No accounts with API access</h3>
        <p className="mt-1 max-w-xs text-sm text-muted-foreground">
          {accounts.length === 0
            ? "Create an ad account with an access token to pull data from the Meta Marketing API."
            : "Add an access token to one of your accounts to use the Meta Marketing API."}
        </p>
        <Button onClick={onRequestCreateAccount} className="mt-4" size="sm">
          <CirclePlus className="size-4" />
          {accounts.length === 0 ? "Create account" : "Add account with token"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Config */}
      <div className="flex flex-col gap-4 rounded-lg border p-5">
        <Controller
          name="accountId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={field.name}>Account</FieldLabel>
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={isSyncing}
              >
                <SelectTrigger aria-invalid={fieldState.invalid}>
                  <SelectValue placeholder="Select account..." />
                </SelectTrigger>
                <SelectContent>
                  {apiAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({a.metaAccountId})
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fieldState.invalid && (
                <FieldError errors={[fieldState.error]} />
              )}
            </Field>
          )}
        />

        <Field>
          <FieldLabel>Date range</FieldLabel>
          <DateRangePicker
            from={parseDateOnly(dateFrom)}
            to={parseDateOnly(dateTo)}
            onChange={(range) => {
              if (range?.from) setDateFrom(formatDateOnly(range.from));
              if (range?.to) setDateTo(formatDateOnly(range.to));
            }}
          />
        </Field>

{/* Breakdowns omitted — Meta restricts combining them with action metrics.
   Use the CSV import tab for breakdown-level data. */}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button
          onClick={() => void form.handleSubmit(handleSync)()}
          disabled={isSyncing}
        >
          {isSyncing ? (
            <Loader2 className="animate-spin" />
          ) : (
            <CloudDownload className="size-4" />
          )}
          {isSyncing ? "Syncing..." : "Sync data"}
        </Button>
      </div>

      {/* Progress */}
      {isSyncing && (
        <div className="rounded-lg border p-5">
          <div className="flex flex-col gap-3">
            <SyncStep
              label="Requesting report from Meta"
              active={phase === "requesting"}
              done={phase !== "requesting"}
            />
            <SyncStep
              label={`Meta is generating report${progress > 0 ? ` (${progress}%)` : ""}`}
              active={phase === "processing"}
              done={["downloading", "importing", "done"].includes(phase)}
            />
            <SyncStep
              label="Downloading data"
              active={phase === "downloading"}
              done={["importing", "done"].includes(phase)}
            />
            <SyncStep
              label="Importing to database"
              active={phase === "importing"}
              done={false}
            />
          </div>
          {phase === "processing" && progress > 0 && (
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Done */}
      {phase === "done" && fetchedRows && (
        <div className="flex items-center justify-between rounded-lg border border-green-500/20 bg-green-500/5 px-5 py-4">
          <div className="flex items-center gap-2">
            <Check className="size-4 text-green-600" />
            <span className="text-sm font-medium">
              Synced {fetchedRows.length.toLocaleString()} rows
            </span>
            <span className="text-xs text-muted-foreground">
              {dateFrom} — {dateTo}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={() => router.push("/creatives")}>
            View creatives
          </Button>
        </div>
      )}
    </div>
  );
}

function SyncStep({
  label,
  active,
  done,
}: {
  label: string;
  active: boolean;
  done: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      {done && !active ? (
        <div className="flex size-5 items-center justify-center rounded-full bg-primary">
          <Check className="size-3 text-primary-foreground" />
        </div>
      ) : active ? (
        <Loader2 className="size-5 animate-spin text-primary" />
      ) : (
        <div className="size-5 rounded-full border-2 border-muted" />
      )}
      <span
        className={`text-sm ${active ? "font-medium" : done ? "text-muted-foreground" : "text-muted-foreground/50"}`}
      >
        {label}
      </span>
    </div>
  );
}
