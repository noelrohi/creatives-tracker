"use client";

import { Shield } from "@/components/icons";
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
import { angleLabel, BUDGET_ROUTING_NOTE } from "./copy";
import { TestPlanStatusSelect } from "./test-plan-status-select";
import type { TestPlanConcept as Concept } from "./types";

const FORMAT_LABELS: Record<string, string> = {
  static: "Static",
  video: "Video",
};

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
 * One concept: the evidence it was written from, the constraints it carries,
 * then its ads flattened to one row each. Everything above the table is read
 * only — the status control on each row is the whole of the interaction.
 */
export function TestPlanConcept({ concept }: { concept: Concept }) {
  return (
    <Card className="gap-0 py-0 overflow-hidden">
      <CardContent className="flex flex-col gap-4 px-6 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">{concept.title}</h2>
          <Badge variant="outline">{angleLabel(concept.angle)}</Badge>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Fact label="Audience">{concept.audience}</Fact>
          <Fact label="Evidence">{concept.evidenceCitation}</Fact>
          <Fact label="Measurement">{concept.measurementPlan}</Fact>
        </div>

        {/* Product-claim risk only (§9) — a constraint on the copy, not a fault. */}
        {concept.claimGuardrail && (
          <div className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-[13px] text-muted-foreground">
            <Shield className="mt-0.5 size-3.5 shrink-0 opacity-60" />
            <p className="flex-1">
              <span className="font-medium text-foreground">Claim guardrail</span>{" "}
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
                    {FORMAT_LABELS[ad.format] ?? ad.format}
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
