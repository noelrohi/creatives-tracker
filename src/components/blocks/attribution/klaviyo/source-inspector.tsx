"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type InspectorData = {
  order: {
    orderId: string;
    orderName: string | null;
    orderDay: string;
    lastClickUtm: {
      source: string | null;
      medium: string | null;
      campaign: string | null;
    };
  };
  result: {
    status: string;
    matchRunId: string;
    claimCount: number;
  } | null;
  candidateEdge: {
    candidateId: string;
    candidateClass: string;
    method: string;
    score: string;
    confidence: string;
    label: string;
  } | null;
  conversionEvent: {
    externalEventId: string;
    occurredAt: string | Date;
    productEvidenceCompleteness: string;
    warnings: string[];
    profile: "present" | "absent";
  } | null;
  caveats: string[];
};

/**
 * Explicit compile-time field rendering only: no Object.keys/entries over
 * response objects, no generic JSON rendering, no JSON.stringify of the
 * query object. Profile IDs and HMAC digests never render — at most the
 * coarse profile-presence flag. Copy exists only for the event external ID.
 */
export function SourceInspector(props: {
  data: InspectorData;
  onCopyEventId?: (externalEventId: string) => void;
}) {
  const { order, result, candidateEdge, conversionEvent } = props.data;
  const truncated = conversionEvent?.warnings.includes(
    "redacted_properties_truncated",
  );
  return (
    <div className="space-y-3 text-sm">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Shopify order
        </p>
        <p>
          {order.orderName ?? order.orderId} · {order.orderDay}
        </p>
        <p className="text-xs text-muted-foreground">
          Last-click UTM: source {order.lastClickUtm.source ?? "—"} · medium{" "}
          {order.lastClickUtm.medium ?? "—"} · campaign{" "}
          {order.lastClickUtm.campaign ?? "—"}
        </p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Current result
        </p>
        {result === null ? (
          <p className="text-muted-foreground">Not evaluated.</p>
        ) : (
          <p>
            {result.status} · run {result.matchRunId} · {result.claimCount}{" "}
            claims
          </p>
        )}
      </div>
      {candidateEdge !== null ? (
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Inspected edge
          </p>
          <Badge variant="secondary">{candidateEdge.label}</Badge>
          <p className="text-xs text-muted-foreground">
            {candidateEdge.method} · {candidateEdge.candidateClass} · score{" "}
            {candidateEdge.score} · confidence {candidateEdge.confidence}
          </p>
        </div>
      ) : null}
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Klaviyo conversion event
        </p>
        {conversionEvent === null ? (
          <p className="text-muted-foreground">No selected event.</p>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs">
                {conversionEvent.externalEventId}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  props.onCopyEventId?.(conversionEvent.externalEventId)
                }
              >
                Copy event ID
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Occurred{" "}
              {typeof conversionEvent.occurredAt === "string"
                ? conversionEvent.occurredAt
                : conversionEvent.occurredAt.toISOString()}{" "}
              · product evidence {conversionEvent.productEvidenceCompleteness} ·
              identity evidence{" "}
              {conversionEvent.profile === "present" ? "present" : "absent"}
            </p>
            {truncated ? (
              <p className="text-xs text-muted-foreground">
                Some source properties were truncated by the server-side
                redaction bound.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
