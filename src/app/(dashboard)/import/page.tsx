"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { ImportCSVDialog } from "@/components/import-csv-dialog";
import { Button } from "@/components/ui/button";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import type { MappedRow } from "@/lib/csv-parser";

export default function ImportPage() {
  const [importOpen, setImportOpen] = useState(false);
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const importMutation = useMutation(
    trpc.adCreative.bulkImport.mutationOptions({
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: trpc.adCreative.list.queryKey() });
        queryClient.invalidateQueries({ queryKey: trpc.ad.list.queryKey() });
        toast.success(`Imported ${data.length} ad${data.length > 1 ? "s" : ""}`);
        setImportOpen(false);
        router.push("/creatives");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  function handleImport(rows: MappedRow[]) {
    importMutation.mutate(
      rows.map((r) => ({
        name: r.name || "Imported Ad",
        roas: r.roas,
        cpa: r.cpa,
        ctr: r.ctr,
        conversionRate: r.conversionRate,
        spend: r.spend,
        conversions: r.conversions != null ? Number(r.conversions) : undefined,
        impressions: r.impressions != null ? Number(r.impressions) : undefined,
        reach: r.reach != null ? Number(r.reach) : undefined,
        frequency: r.frequency,
        cpm: r.cpm,
        qualityRanking: r.qualityRanking,
        engagementRateRanking: r.engagementRateRanking,
        conversionRateRanking: r.conversionRateRanking,
        linkClicks: r.linkClicks != null ? Number(r.linkClicks) : undefined,
        clicksAll: r.clicksAll != null ? Number(r.clicksAll) : undefined,
        cpc: r.cpc,
        ctrLinkClick: r.ctrLinkClick,
        landingPageViews: r.landingPageViews != null ? Number(r.landingPageViews) : undefined,
        costPerLpv: r.costPerLpv,
        purchaseValue: r.purchaseValue,
        delivery: r.delivery,
        dateStart: r.dateStart || new Date().toISOString().slice(0, 10),
        dateEnd: r.dateEnd || new Date().toISOString().slice(0, 10),
      })),
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Import Ads</h1>
        <p className="text-sm text-muted-foreground">
          Upload a Meta Ads Manager report to import your ads with performance
          data.
        </p>
      </div>

      <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-16">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted/50">
          <Upload className="size-5 text-muted-foreground/40" />
        </div>
        <div className="text-center">
          <p className="text-sm text-muted-foreground">
            Import from CSV
          </p>
          <p className="text-[13px] text-muted-foreground/40">
            Auto-detects Meta Ads Manager report format.
          </p>
        </div>
        <Button
          variant="outline"
          className="gap-1.5"
          onClick={() => setImportOpen(true)}
        >
          <Upload className="size-3.5" />
          Upload CSV
        </Button>
      </div>

      <ImportCSVDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        expectedLevel="ad"
        onImport={handleImport}
        importing={importMutation.isPending}
      />
    </div>
  );
}
