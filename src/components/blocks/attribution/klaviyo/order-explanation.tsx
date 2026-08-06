"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type ExplanationData = {
  orderId: string;
  orderStatus: string;
  matchRunId: string | null;
  matcherVersion: string | null;
  reasonCodes: string[];
  boundaryWarning: boolean;
  candidates: Array<{
    candidateId: string;
    candidateClass: string;
    method: string;
    score: string;
    confidence: string;
    reasonCodes: string[];
    selected: boolean;
  }>;
};

/**
 * Matcher explanation. Diagnostic candidates stay candidate/ambiguous —
 * inspection never offers a confirm action or selects a winner.
 */
export function OrderExplanation(props: {
  data: ExplanationData;
  selectedCandidateId: string | null;
  onInspectCandidate: (candidateId: string | null) => void;
}) {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{props.data.orderStatus}</Badge>
        <span className="text-xs text-muted-foreground">
          Matcher {props.data.matcherVersion ?? "—"} · Run{" "}
          {props.data.matchRunId ?? "—"}
        </span>
        {props.data.boundaryWarning ? (
          <Badge variant="secondary">Boundary warning</Badge>
        ) : null}
      </div>
      {props.data.reasonCodes.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Reasons: {props.data.reasonCodes.join(", ")}
        </p>
      ) : null}
      <div className="space-y-2">
        {props.data.candidates.length === 0 ? (
          <p className="text-muted-foreground">No candidate edges.</p>
        ) : (
          props.data.candidates.map((candidate) => (
            <div
              key={candidate.candidateId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
            >
              <div className="space-y-0.5">
                <p>
                  {candidate.method} ·{" "}
                  <span className="text-muted-foreground">
                    {candidate.candidateClass === "deterministic"
                      ? "deterministic"
                      : "diagnostic (advisory)"}
                  </span>
                  {candidate.selected ? " · selected" : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  score {candidate.score} · confidence {candidate.confidence}
                  {candidate.reasonCodes.length > 0
                    ? ` · ${candidate.reasonCodes.join(", ")}`
                    : ""}
                </p>
              </div>
              <Button
                size="sm"
                variant={
                  props.selectedCandidateId === candidate.candidateId
                    ? "default"
                    : "outline"
                }
                onClick={() =>
                  props.onInspectCandidate(
                    props.selectedCandidateId === candidate.candidateId
                      ? null
                      : candidate.candidateId,
                  )
                }
              >
                {props.selectedCandidateId === candidate.candidateId
                  ? "Stop inspecting"
                  : "Inspect edge"}
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
