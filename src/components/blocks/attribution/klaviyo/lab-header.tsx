"use client";

import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LabPanelState } from "./panel-state";

export type LabHealth = {
  configured: boolean;
  store: {
    shopDomain: string;
    ianaTimezone: string;
    todayInStoreTz: string;
  } | null;
  connection: {
    status: string;
    accountName: string | null;
    timezone: string | null;
    currency: string | null;
    todayInAccountTz: string | null;
    lastDiscoverySyncedAt: string | Date | null;
    lastEventSyncedAt: string | Date | null;
  } | null;
};

function freshness(value: string | Date | null): string {
  if (value === null) return "never";
  const date = typeof value === "string" ? new Date(value) : value;
  return formatDistanceToNow(date, { addSuffix: true });
}

/**
 * Connection health and the two explicit source controls. A missing
 * connection is the environment-configuration empty state — discovery is
 * server-owned; no credential entry or self-service connection UI exists.
 */
export function LabHeader(props: {
  health: LabHealth | null;
  healthError: boolean;
  onRetryHealth: () => void;
  busy: boolean;
  syncLocked: boolean;
  recomputeLocked: boolean;
  onStartDiscovery: () => void;
  onSyncNow: () => void;
  onRecompute: () => void;
}) {
  if (props.healthError) {
    return (
      <LabPanelState
        kind="error"
        title="Connection health could not load"
        body="Previously loaded evidence remains unchanged."
        onRetry={props.onRetryHealth}
      />
    );
  }
  if (props.health === null) {
    return <LabPanelState kind="loading" title="Loading health" body="" />;
  }
  if (!props.health.configured || props.health.connection === null) {
    return (
      <div className="flex flex-col items-start gap-2 rounded-md border p-4">
        <p className="text-sm font-medium">No Klaviyo connection yet</p>
        <p className="text-sm text-muted-foreground">
          The pilot connection is configured from the server environment.
          Discover the environment-backed account to begin — no credentials
          are entered here.
        </p>
        <Button size="sm" onClick={props.onStartDiscovery} disabled={props.busy}>
          Discover connection
        </Button>
      </div>
    );
  }
  const connection = props.health.connection;
  const degraded =
    connection.status === "degraded" || connection.status === "disabled";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">
            {connection.accountName ?? "Klaviyo account"}
          </p>
          <Badge variant={degraded ? "destructive" : "outline"}>
            {connection.status}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Store {props.health.store?.ianaTimezone ?? "—"} · Account{" "}
          {connection.timezone ?? "—"} · {connection.currency ?? "—"} · Last
          discovery {freshness(connection.lastDiscoverySyncedAt)} · Last events{" "}
          {freshness(connection.lastEventSyncedAt)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={props.onSyncNow}
          disabled={props.busy || props.syncLocked}
        >
          Sync now
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={props.onRecompute}
          disabled={props.busy || props.recomputeLocked}
        >
          Recompute matches
        </Button>
      </div>
    </div>
  );
}
