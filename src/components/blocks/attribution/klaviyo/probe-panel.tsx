"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type ProbeReportRow = {
  id: string;
  status: string;
  sampledFrom: string | Date;
  sampledTo: string | Date;
  sampledShopifyOrders: number;
  sampledKlaviyoEvents: number;
  bindingOverlapCount: number;
  identifierCoverage: Record<string, number>;
  collisionSummary: Record<string, number>;
  productCoverage: Record<string, number>;
  attributionCoverage: Record<string, number>;
  reviewNote: string | null;
};

export type JoinRuleRow = {
  id: string;
  eventKind: string;
  sourceProperty: string;
  targetNamespace: string;
  canonicalizer: string;
  state: string;
  observedPopulated: number;
  observedCollisions: number;
};

/**
 * Probe gate and join-rule review. Reviews require a bounded non-empty
 * note; the stored probe-generated canonicalization is displayed
 * read-only and never submitted or changed. Rule approval stays
 * unavailable until the probe is passed, and a rule with nonzero observed
 * collisions cannot be approved from here.
 */
export function ProbePanel(props: {
  reports: ProbeReportRow[];
  rules: JoinRuleRow[];
  busy: boolean;
  onRunProbe: () => void;
  onReviewProbe: (input: {
    reportId: string;
    decision: "approve" | "reject";
    reviewNote: string;
  }) => void;
  onReviewRule: (input: {
    ruleId: string;
    decision: "approve" | "reject";
    reviewNote: string;
  }) => void;
}) {
  const [probeNote, setProbeNote] = useState("");
  // Per-rule notes: one shared field would mirror typing across rows.
  const [ruleNotes, setRuleNotes] = useState<Record<string, string>>({});
  const latest = props.reports[0] ?? null;
  const probePassed = latest?.status === "passed";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Probe gate</h2>
          {latest ? (
            <Badge variant={probePassed ? "outline" : "secondary"}>
              {latest.status}
            </Badge>
          ) : null}
        </div>
        <Button size="sm" onClick={props.onRunProbe} disabled={props.busy}>
          Run probe
        </Button>
      </div>

      {latest === null ? (
        <p className="text-sm text-muted-foreground">
          No probe report yet. Broad evidence syncs stay locked until a
          sampled probe passes review.
        </p>
      ) : (
        <div className="space-y-2 rounded-md border p-3 text-sm">
          <p>
            Sampled {latest.sampledShopifyOrders} Shopify orders and{" "}
            {latest.sampledKlaviyoEvents} Klaviyo events ·{" "}
            {latest.bindingOverlapCount} overlapping bindings
          </p>
          <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <CoverageList label="Field coverage" data={latest.identifierCoverage} />
            <CoverageList label="Collisions" data={latest.collisionSummary} />
            <CoverageList label="Product coverage" data={latest.productCoverage} />
            <CoverageList
              label="Claim coverage"
              data={latest.attributionCoverage}
            />
          </dl>
          {latest.status === "pending" ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Input
                aria-label="Probe review note"
                placeholder="Review note (required)"
                value={probeNote}
                maxLength={1000}
                onChange={(event) => setProbeNote(event.target.value)}
                className="h-8 w-64"
              />
              <Button
                size="sm"
                disabled={props.busy || probeNote.trim().length === 0}
                onClick={() =>
                  props.onReviewProbe({
                    reportId: latest.id,
                    decision: "approve",
                    reviewNote: probeNote.trim(),
                  })
                }
              >
                Approve probe
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={props.busy || probeNote.trim().length === 0}
                onClick={() =>
                  props.onReviewProbe({
                    reportId: latest.id,
                    decision: "reject",
                    reviewNote: probeNote.trim(),
                  })
                }
              >
                Reject probe
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Join rules</h3>
        {props.rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No candidate join rules yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event kind</TableHead>
                  <TableHead>Source property</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Canonicalization</TableHead>
                  <TableHead>Populated</TableHead>
                  <TableHead>Collisions</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Review</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {props.rules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell>{rule.eventKind}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {rule.sourceProperty}
                    </TableCell>
                    <TableCell>{rule.targetNamespace}</TableCell>
                    <TableCell>
                      {/* Stored probe-generated value, read-only. */}
                      <span className="font-mono text-xs">
                        {rule.canonicalizer}
                      </span>
                    </TableCell>
                    <TableCell>{rule.observedPopulated}</TableCell>
                    <TableCell>{rule.observedCollisions}</TableCell>
                    <TableCell>{rule.state}</TableCell>
                    <TableCell>
                      {rule.state === "candidate" ? (
                        <div className="flex items-center gap-2">
                          <Input
                            aria-label={`Rule review note ${rule.id}`}
                            placeholder="Review note (required)"
                            value={ruleNotes[rule.id] ?? ""}
                            maxLength={1000}
                            onChange={(event) =>
                              setRuleNotes((prior) => ({
                                ...prior,
                                [rule.id]: event.target.value,
                              }))
                            }
                            className="h-8 w-44"
                          />
                          <Button
                            size="sm"
                            disabled={
                              props.busy ||
                              !probePassed ||
                              (ruleNotes[rule.id] ?? "").trim().length === 0 ||
                              rule.observedCollisions > 0
                            }
                            onClick={() =>
                              props.onReviewRule({
                                ruleId: rule.id,
                                decision: "approve",
                                reviewNote: (ruleNotes[rule.id] ?? "").trim(),
                              })
                            }
                          >
                            Approve rule
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              props.busy || (ruleNotes[rule.id] ?? "").trim().length === 0
                            }
                            onClick={() =>
                              props.onReviewRule({
                                ruleId: rule.id,
                                decision: "reject",
                                reviewNote: (ruleNotes[rule.id] ?? "").trim(),
                              })
                            }
                          >
                            Reject rule
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

function CoverageList(props: { label: string; data: Record<string, number> }) {
  const entries = Object.entries(props.data);
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {props.label}
      </dt>
      {entries.length === 0 ? (
        <dd className="text-xs text-muted-foreground">Unavailable</dd>
      ) : (
        entries.map(([key, value]) => (
          <dd key={key} className="text-xs">
            {key}: {value}
          </dd>
        ))
      )}
    </div>
  );
}
