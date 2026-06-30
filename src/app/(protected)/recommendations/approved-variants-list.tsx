"use client";

import Link from "next/link";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton, EmptyState, LoadError } from "./recommendation-ui";
import type { ApprovedVariantRow } from "./types";
import { variantToText } from "./variant-utils";

export function ApprovedVariantsList({
  approvedRows,
  isLoading,
  isError,
  errorMessage,
}: {
  approvedRows: ApprovedVariantRow[];
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
}) {
  const copyAllApproved = async () => {
    if (approvedRows.length === 0) return;
    const text = approvedRows
      .map((row) => `# ${row.sourceName} → ${row.variant.copy.variantName}\n${variantToText(row.variant.copy)}`)
      .join("\n\n———\n\n");
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${approvedRows.length} approved variant${approvedRows.length === 1 ? "" : "s"}`);
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          {approvedRows.length > 0
            ? `${approvedRows.length} variant${approvedRows.length === 1 ? "" : "s"} ready to hand off to your creative team.`
            : "Variants you approve will collect here."}
        </p>
        {approvedRows.length > 0 ? (
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[12px]" onClick={copyAllApproved}>
            <Copy className="size-3.5" /> Copy all
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : isError ? (
        <LoadError title="Could not load approved variants" message={errorMessage ?? "Unknown error"} />
      ) : approvedRows.length === 0 ? (
        <EmptyState>
          Nothing approved yet. Head to <span className="font-medium text-foreground">Winners</span>,
          generate variants, and mark the good ones.
        </EmptyState>
      ) : (
        approvedRows.map((row) => (
          <div
            key={row.variant.id}
            className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.03] p-4"
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold">{row.variant.copy.variantName}</h3>
                <Link
                  href={`/creatives/${row.sourceCreativeId}?from=${row.windowFrom}&to=${row.windowTo}`}
                  className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                >
                  from {row.sourceName}
                </Link>
              </div>
              <CopyButton
                text={variantToText(row.variant.copy)}
                label="Variant"
                className="h-7 px-2"
              />
            </div>
            <div className="rounded-md bg-background/60 px-3 py-2">
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed">
                {row.variant.copy.primaryText}
              </p>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
              <span className="text-foreground/70">Headline:</span> {row.variant.copy.headline}
              {"  ·  "}
              <span className="text-foreground/70">Hook:</span> {row.variant.copy.hook}
              {"  ·  "}
              <span className="text-foreground/70">CTA:</span> {row.variant.copy.cta}
            </p>
          </div>
        ))
      )}
    </section>
  );
}
