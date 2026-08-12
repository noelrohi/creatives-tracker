"use client";

import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { JOURNEY_LOOKBACKS, type JourneyLookback } from "./copy";

export type JourneyData =
  | { kind: "none"; reason: string }
  | {
      kind: "journey";
      label: "same_klaviyo_profile";
      events: Array<{
        eventRowId: string;
        metricKind: string | null;
        occurredAt: string | Date;
      }>;
      clipped: boolean;
      caveats: string[];
    };

/**
 * Exact-profile timeline. The label is always `Same Klaviyo profile` —
 * never "same customer" — and a profile-merge caveat surfaces verbatim
 * from the projection.
 */
export function JourneyTimeline(props: {
  data: JourneyData;
  lookback: JourneyLookback;
  onLookbackChange: (lookback: JourneyLookback) => void;
}) {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <Select
          value={String(props.lookback)}
          onValueChange={(value) =>
            props.onLookbackChange(Number(value) as JourneyLookback)
          }
        >
          <SelectTrigger className="h-8 w-32" aria-label="Journey lookback">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {JOURNEY_LOOKBACKS.map((days) => (
              <SelectItem key={days} value={String(days)}>
                Last {days} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Badge variant="outline">Same Klaviyo profile</Badge>
      </div>
      {props.data.kind === "none" ? (
        <p className="text-muted-foreground">
          No journey: {props.data.reason.replaceAll("_", " ")}. Journeys exist
          only for a confirmed selected conversion with a stored profile
          relationship.
        </p>
      ) : (
        <>
          {props.data.caveats.includes("profile_merge_possible") ? (
            <p className="text-xs text-muted-foreground">
              Klaviyo profiles can merge; this timeline is pseudonymous source
              evidence, not proof of one person.
            </p>
          ) : null}
          {props.data.clipped ? (
            <p className="text-xs text-muted-foreground">
              Clipped to ingested journey coverage.
            </p>
          ) : null}
          {props.data.events.length === 0 ? (
            <p className="text-muted-foreground">
              No canonical journey events in this lookback.
            </p>
          ) : (
            <ol className="space-y-1">
              {props.data.events.map((event) => (
                <li key={event.eventRowId} className="flex justify-between gap-2">
                  <span>{event.metricKind ?? "unknown metric"}</span>
                  <span className="text-xs text-muted-foreground">
                    {typeof event.occurredAt === "string"
                      ? event.occurredAt
                      : event.occurredAt.toISOString()}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
