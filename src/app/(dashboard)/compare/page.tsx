"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft } from "lucide-react";

type CompareType = "ad_set" | "ad_creative" | "campaign_config";

function useEntityData(type: CompareType, id: string | null) {
  const trpc = useTRPC();

  const adSet = useQuery({
    ...trpc.adSet.getById.queryOptions({ id: id ?? "" }),
    enabled: type === "ad_set" && !!id,
  });

  const creative = useQuery({
    ...trpc.adCreative.getById.queryOptions({ id: id ?? "" }),
    enabled: type === "ad_creative" && !!id,
  });

  const campaign = useQuery({
    ...trpc.campaignConfig.getById.queryOptions({ id: id ?? "" }),
    enabled: type === "campaign_config" && !!id,
  });

  if (type === "ad_set") return adSet;
  if (type === "ad_creative") return creative;
  return campaign;
}

function usePerformanceLogs(type: CompareType, id: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.performanceLog.listByAdSet.queryOptions({ adSetId: id ?? "" }),
    enabled: type === "ad_set" && !!id,
  });
}

interface FieldDef {
  label: string;
  key: string;
  format?: (v: unknown) => string;
}

const AD_SET_FIELDS: FieldDef[] = [
  { label: "Name", key: "name" },
  { label: "Creative", key: "adCreativeName" },
  { label: "Landing Page", key: "landingPageName" },
  { label: "Campaign", key: "campaignConfigName" },
  { label: "Notes", key: "notes" },
];

const CREATIVE_FIELDS: FieldDef[] = [
  { label: "Name", key: "name" },
  { label: "Format", key: "format" },
  { label: "Angle", key: "angle" },
  { label: "Persona", key: "persona" },
  { label: "Awareness", key: "awarenessLevel" },
  { label: "Hook", key: "hook" },
  { label: "CTA", key: "cta" },
  { label: "Notes", key: "notes" },
];

const CAMPAIGN_FIELDS: FieldDef[] = [
  { label: "Name", key: "name" },
  { label: "Objective", key: "objective" },
  { label: "Cost Cap", key: "costCap" },
  { label: "Daily Budget", key: "dailyBudget" },
  { label: "Demographics", key: "demographics" },
  { label: "Notes", key: "notes" },
];

function getFields(type: CompareType) {
  if (type === "ad_set") return AD_SET_FIELDS;
  if (type === "ad_creative") return CREATIVE_FIELDS;
  return CAMPAIGN_FIELDS;
}

function getBackLink(type: CompareType) {
  if (type === "ad_set") return "/ad-sets";
  if (type === "ad_creative") return "/creatives";
  return "/campaigns";
}

function getVal(data: Record<string, unknown> | undefined, key: string): string {
  if (!data) return "—";
  const val = data[key];
  if (val === null || val === undefined) return "—";
  if (Array.isArray(val)) return val.join(", ") || "—";
  return String(val) || "—";
}

export default function ComparePage() {
  const searchParams = useSearchParams();
  const type = (searchParams.get("type") ?? "ad_set") as CompareType;
  const idA = searchParams.get("a");
  const idB = searchParams.get("b");

  const entityA = useEntityData(type, idA);
  const entityB = useEntityData(type, idB);
  const logsA = usePerformanceLogs(type, idA);
  const logsB = usePerformanceLogs(type, idB);

  const fields = getFields(type);
  const isLoading = entityA.isLoading || entityB.isLoading;

  if (!idA || !idB) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24">
        <p className="text-sm text-muted-foreground">
          Select two items to compare. Use the URL params: ?type=ad_set&a=id1&b=id2
        </p>
      </div>
    );
  }

  const dataA = entityA.data as Record<string, unknown> | undefined;
  const dataB = entityB.data as Record<string, unknown> | undefined;

  // Compute latest performance averages for ad sets
  const perfA = logsA.data?.slice(0, 5);
  const perfB = logsB.data?.slice(0, 5);

  function avg(logs: typeof perfA, field: string): number | null {
    if (!logs || logs.length === 0) return null;
    const vals = logs
      .map((l) => {
        const v = (l as Record<string, unknown>)[field];
        return v !== null && v !== undefined ? Number(v) : null;
      })
      .filter((v): v is number => v !== null && !isNaN(v));
    if (vals.length === 0) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  const perfFields = ["roas", "cpa", "ctr", "conversionRate", "spend", "conversions"];
  const perfLabels: Record<string, string> = {
    roas: "Avg ROAS",
    cpa: "Avg CPA",
    ctr: "Avg CTR",
    conversionRate: "Avg Conv Rate",
    spend: "Avg Spend",
    conversions: "Avg Conversions",
  };
  const perfFormat: Record<string, (v: number) => string> = {
    roas: (v) => v.toFixed(2),
    cpa: (v) => `$${v.toFixed(2)}`,
    ctr: (v) => `${v.toFixed(2)}%`,
    conversionRate: (v) => `${v.toFixed(2)}%`,
    spend: (v) => `$${v.toFixed(2)}`,
    conversions: (v) => v.toFixed(0),
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href={getBackLink(type)}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Compare</h1>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="grid grid-cols-[140px_1fr_1fr] gap-4">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* Field comparison */}
          <div className="rounded-lg border overflow-hidden">
            <div className="grid grid-cols-[160px_1fr_1fr] bg-muted/30 px-4 py-2.5 text-sm font-medium">
              <span>Field</span>
              <span>{getVal(dataA, "name")}</span>
              <span>{getVal(dataB, "name")}</span>
            </div>
            <div className="divide-y">
              {fields.map((field) => {
                const valA = getVal(dataA, field.key);
                const valB = getVal(dataB, field.key);
                const isDiff = valA !== valB;
                return (
                  <div
                    key={field.key}
                    className={`grid grid-cols-[160px_1fr_1fr] px-4 py-2.5 text-sm ${
                      isDiff ? "bg-amber-50 dark:bg-amber-950/20" : ""
                    }`}
                  >
                    <span className="text-muted-foreground">{field.label}</span>
                    <span className="capitalize">
                      {valA.replace(/_/g, " ")}
                    </span>
                    <span className="capitalize">
                      {valB.replace(/_/g, " ")}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Performance comparison for ad sets */}
          {type === "ad_set" && (perfA?.length || perfB?.length) ? (
            <div className="rounded-lg border overflow-hidden">
              <div className="bg-muted/30 px-4 py-2.5 text-sm font-medium">
                Performance Metrics (last 5 logs avg)
              </div>
              <div className="divide-y">
                {perfFields.map((field) => {
                  const a = avg(perfA, field);
                  const b = avg(perfB, field);
                  const fmt = perfFormat[field];
                  let delta = "";
                  if (a !== null && b !== null && a !== 0) {
                    const ratio = b / a;
                    if (field === "cpa" || field === "spend") {
                      delta = ratio < 1
                        ? `↓ ${((1 - ratio) * 100).toFixed(0)}%`
                        : ratio > 1
                          ? `↑ ${((ratio - 1) * 100).toFixed(0)}%`
                          : "";
                    } else {
                      delta = ratio > 1
                        ? `↑ ${((ratio - 1) * 100).toFixed(0)}%`
                        : ratio < 1
                          ? `↓ ${((1 - ratio) * 100).toFixed(0)}%`
                          : "";
                    }
                  }
                  return (
                    <div
                      key={field}
                      className="grid grid-cols-[160px_1fr_1fr_80px] px-4 py-2.5 text-sm"
                    >
                      <span className="text-muted-foreground">
                        {perfLabels[field]}
                      </span>
                      <span>{a !== null ? fmt(a) : "—"}</span>
                      <span>{b !== null ? fmt(b) : "—"}</span>
                      <span className="text-xs text-muted-foreground">
                        {delta && (
                          <Badge
                            variant="outline"
                            className={`text-xs ${
                              delta.startsWith("↑") &&
                              field !== "cpa" &&
                              field !== "spend"
                                ? "text-green-600 border-green-200"
                                : delta.startsWith("↓") &&
                                    field !== "cpa" &&
                                    field !== "spend"
                                  ? "text-red-600 border-red-200"
                                  : delta.startsWith("↓")
                                    ? "text-green-600 border-green-200"
                                    : "text-red-600 border-red-200"
                            }`}
                          >
                            {delta}
                          </Badge>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
