"use client";

import { AlertCircle } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export type LabPanelStateKind =
  | "loading"
  | "empty"
  | "filtered-empty"
  | "error";

/**
 * Shared playground panel state. An error is always distinguishable from
 * an empty result: errors keep previously loaded evidence visible and
 * offer Retry; filtered-empty offers Clear filters; empty is text only.
 */
export function LabPanelState(props: {
  kind: LabPanelStateKind;
  title: string;
  body: string;
  onRetry?: () => void;
  onClearFilters?: () => void;
}) {
  if (props.kind === "loading") {
    return (
      <div className="space-y-2 p-4" aria-busy="true">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-5 w-3/5" />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2 p-4">
      <div className="flex items-center gap-2">
        {props.kind === "error" ? (
          <AlertCircle className="size-4 text-destructive" />
        ) : null}
        <p className="text-sm font-medium">{props.title}</p>
      </div>
      {props.body ? (
        <p className="text-sm text-muted-foreground">{props.body}</p>
      ) : null}
      {props.kind === "error" && props.onRetry ? (
        <Button size="sm" variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      ) : null}
      {props.kind === "filtered-empty" && props.onClearFilters ? (
        <Button size="sm" variant="outline" onClick={props.onClearFilters}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
