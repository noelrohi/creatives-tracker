"use client";

import { Badge } from "@/components/ui/badge";

export type ClaimsData =
  | { kind: "none"; reason: string }
  | {
      kind: "canonical" | "diagnostic";
      conversionEventId: string;
      claims: Array<{
        attributionId: string;
        campaign: { id: string; name: string } | null;
        flow: { id: string; name: string } | null;
        message: { id: string; name: string } | null;
        externalVariationReference: string | null;
        interaction: {
          type: string | null;
          occurredAt: string | Date | null;
          channel: string | null;
          host: string | null;
          path: string | null;
          botClick: boolean | null;
        } | null;
        unknownReasonCodes: string[];
      }>;
      replay: {
        status: string;
        reasonCodes: string[];
      } | null;
      caveats: string[];
    };

function node(label: string, value: { name: string } | null): string {
  return value === null ? `${label}: Unknown` : `${label}: ${value.name}`;
}

/**
 * Advisory claim chain. Opens and deliveries are never relabelled clicks,
 * a missing relationship stays `Unknown`, bot warnings appear only when
 * the source field exists, and diagnostic chains are explicitly
 * non-canonical.
 */
export function ClaimsChain({ data }: { data: ClaimsData }) {
  if (data.kind === "none") {
    return (
      <p className="text-sm text-muted-foreground">
        No claim chain: {data.reason.replaceAll("_", " ")}.
      </p>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant={data.kind === "canonical" ? "outline" : "secondary"}>
          {data.kind === "canonical"
            ? "Canonical conversion chain"
            : "Per-edge diagnostic — non-canonical"}
        </Badge>
        {data.caveats.includes("claims_stale_or_incomplete") ? (
          <Badge variant="secondary">Stale or incomplete refresh</Badge>
        ) : null}
      </div>
      {data.claims.length === 0 ? (
        <p className="text-muted-foreground">No stored claims yet.</p>
      ) : (
        data.claims.map((claim) => (
          <div key={claim.attributionId} className="rounded-md border p-2">
            <p className="text-xs text-muted-foreground">
              Attribution {claim.attributionId}
            </p>
            <p>
              {claim.interaction === null
                ? "Interaction: Unknown"
                : `Interaction: ${claim.interaction.type ?? "Unknown"}${
                    claim.interaction.host
                      ? ` · ${claim.interaction.host}${claim.interaction.path ?? ""}`
                      : ""
                  }`}
            </p>
            <p>{node("Message", claim.message)}</p>
            <p>
              {claim.campaign !== null
                ? node("Campaign", claim.campaign)
                : claim.flow !== null
                  ? node("Flow", claim.flow)
                  : "Campaign or flow: Unknown"}
            </p>
            {claim.interaction?.botClick === true ? (
              <Badge variant="secondary">Bot click reported</Badge>
            ) : null}
            {claim.unknownReasonCodes.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Unknown reasons: {claim.unknownReasonCodes.join(", ")}
              </p>
            ) : null}
          </div>
        ))
      )}
      {data.replay !== null && data.replay.status !== "complete" ? (
        <p className="text-xs text-muted-foreground">
          Claim refresh {data.replay.status}
          {data.replay.reasonCodes.length > 0
            ? ` (${data.replay.reasonCodes.join(", ")})`
            : ""}
          ; the previous chain remains shown.
        </p>
      ) : null}
    </div>
  );
}
