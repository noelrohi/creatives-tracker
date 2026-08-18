"use client";

import { ExternalLink, Shield } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adLibraryPageUrl } from "./ad-library";
import { AdPreviewStrip } from "./ad-preview-strip";
import { angleLabel, BUDGET_ROUTING_NOTE } from "./copy";
import { daysSince, TEST_PLAN_FORMAT_LABELS } from "./display";
import { TestPlanStatusSelect } from "./test-plan-status-select";
import type { TestPlanConcept as Concept } from "./types";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </p>
      <p className="text-[13px] leading-relaxed">{children}</p>
    </div>
  );
}

/**
 * The competitor ads this concept was written from. Evidence cluster ids
 * dangle after a re-fill (§3), so the strip renders only while the router can
 * still resolve them.
 */
function InspiredBy({ inspiration }: { inspiration: Concept["inspiration"] }) {
  if (!inspiration) return null;

  const days = daysSince(inspiration.oldestStartDate);

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
      {inspiration.previewAds.length > 0 && (
        <AdPreviewStrip
          ads={inspiration.previewAds}
          alt={`${inspiration.competitorName} ad`}
          thumbClassName="h-[68px] w-[54px] rounded-md"
          className="gap-1.5"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">
          Inspired by {inspiration.adCount} {inspiration.competitorName}{" "}
          {inspiration.adCount === 1 ? "ad" : "ads"}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {inspiration.clusterLabel}
          {days !== null && ` · on air ${days} days`}
        </p>
      </div>
      <a
        href={adLibraryPageUrl(inspiration.metaPageId)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        View in Ad Library <ExternalLink className="size-3" />
      </a>
    </div>
  );
}

/**
 * One concept: why it exists in one line, the competitor ads it came from, the
 * constraints it carries, then its ads flattened to one row each. Everything
 * above the table is read only — the status control on each row is the whole
 * of the interaction.
 */
export function TestPlanConcept({ concept }: { concept: Concept }) {
  return (
    <Card className="gap-0 py-0 overflow-hidden">
      <CardContent className="flex flex-col gap-4 px-6 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">{concept.title}</h2>
          <Badge variant="outline">{angleLabel(concept.angle)}</Badge>
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
            Why this test
          </p>
          <p className="text-[13px] leading-relaxed">
            {concept.evidenceCitation}
          </p>
        </div>

        <InspiredBy inspiration={concept.inspiration} />

        <div className="grid gap-3 sm:grid-cols-2">
          <Fact label="Who sees it">{concept.audience}</Fact>
          <Fact label="How we'll judge it">{concept.measurementPlan}</Fact>
        </div>

        {/* Product-claim risk only (§9) — a constraint on the copy, not a fault. */}
        {concept.claimGuardrail && (
          <div className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-[13px] text-muted-foreground">
            <Shield className="mt-0.5 size-3.5 shrink-0 opacity-60" />
            <p className="flex-1">
              <span className="font-medium text-foreground">Copy guardrail</span>{" "}
              — {concept.claimGuardrail}
            </p>
          </div>
        )}

        {/*
         * The budget-routing rule, on every header without exception: §9 makes
         * it a deterministic fixture, so it is rendered from app code and never
         * from anything the generator returned.
         */}
        <p className="text-[11px] leading-relaxed text-muted-foreground/70">
          {BUDGET_ROUTING_NOTE}
        </p>
      </CardContent>

      <div className="border-t">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Hook</TableHead>
              <TableHead className="w-24">Format</TableHead>
              <TableHead className="w-32">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {concept.ads.map((ad, index) => (
              <TableRow key={ad.id}>
                <TableCell className="text-[13px] tabular-nums text-muted-foreground/70">
                  {index + 1}
                </TableCell>
                <TableCell className="text-[13px]">{ad.hook}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-normal">
                    {TEST_PLAN_FORMAT_LABELS[ad.format] ?? ad.format}
                  </Badge>
                </TableCell>
                <TableCell>
                  <TestPlanStatusSelect
                    adId={ad.id}
                    hook={ad.hook}
                    status={ad.status}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
