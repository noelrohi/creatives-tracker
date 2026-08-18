"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AlertCircle, ArrowLeft } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatAge,
  formatCentsMoney,
  formatMoney,
} from "@/components/blocks/attribution/format";
import { LabPanelState } from "@/components/blocks/attribution/klaviyo/panel-state";
import { addDays } from "@/lib/day";
import { getUserFacingErrorMessage } from "@/lib/errors";
import { useTRPC } from "@/lib/trpc/client";

const RANGE_OPTIONS = [7, 30, 90] as const;
type RangeDays = (typeof RANGE_OPTIONS)[number];

/** Short, human copy for the sync-run and probe error codes the nightly
 * schedule and the manual triggers here can both leave behind. Unknown codes
 * fall back to the raw string rather than hiding the failure. */
const ERROR_CODE_COPY: Record<string, string> = {
  credential_invalid: "Credentials misconfigured — check the server environment",
  currency_changed: "Account currency changed — needs manual review",
  manager_account: "Configured account is a manager (MCC) — use a client account",
  customer_mismatch: "Configured customer ID does not match the account",
  provider_rejected: "Google rejected the request",
  retry_exhausted: "Retries exhausted",
  trigger_dispatch_failed: "Background dispatch failed",
  internal_error: "Unexpected sync failure",
  provider_unavailable: "Google was unreachable — will retry",
  malformed_customer: "Google returned an unexpected account shape",
};

function errorCodeCopy(code: string | null | undefined): string {
  if (!code) return "unknown error";
  return ERROR_CODE_COPY[code] ?? code;
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Deliberately minimal: connection status, the gclid coverage probe, and a
 * read-only view of the stored Google Ads campaign facts beside the
 * attribution page's own "google" bucket, for sanity-checking the pilot
 * ingest — not a working campaign console.
 */
export function GoogleAdsLab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);

  const health = useQuery({
    ...trpc.googleAds.health.queryOptions(),
    // A queued run finishes in the background; poll until it settles so the
    // action buttons re-enable on their own.
    refetchInterval: (query) =>
      query.state.data?.syncRuns.some((run) => run.status === "running")
        ? 5_000
        : false,
  });
  const probeReport = useQuery({
    ...trpc.googleAds.probeReport.queryOptions(),
    // A running probe finishes in the background; poll until it settles.
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 5_000 : false,
  });
  const probeRunning = probeReport.data?.status === "running";
  const connection = health.data?.connection ?? null;

  const toDay = isoToday();
  const fromDay = addDays(toDay, -(rangeDays - 1));
  const facts = useQuery({
    ...trpc.googleAds.campaignFacts.queryOptions({ fromDay, toDay }),
    enabled: connection !== null,
  });

  const invalidateEvidence = () => {
    void queryClient.invalidateQueries();
  };
  const onActionError = (fallback: string) => (error: unknown) => {
    toast.error(getUserFacingErrorMessage(error, fallback));
  };

  const runProbe = useMutation(
    trpc.googleAds.runProbe.mutationOptions({
      onSuccess: () => {
        toast.success("Probe queued");
        invalidateEvidence();
      },
      onError: onActionError("Probe could not start"),
    }),
  );
  const startDiscovery = useMutation(
    trpc.googleAds.startDiscovery.mutationOptions({
      onSuccess: () => {
        toast.success("Discovery queued");
        invalidateEvidence();
      },
      onError: onActionError("Discovery could not start"),
    }),
  );
  const startFactsSync = useMutation(
    trpc.googleAds.startFactsSync.mutationOptions({
      onSuccess: () => {
        toast.success("Facts sync queued");
        invalidateEvidence();
      },
      onError: onActionError("Facts sync could not start"),
    }),
  );

  const latestRun = health.data?.syncRuns[0] ?? null;
  const latestRunFailed = latestRun?.status === "failed";
  const discoveryRunning =
    health.data?.syncRuns.some(
      (run) => run.operation === "discovery" && run.status === "running",
    ) ?? false;
  const factsRunning =
    health.data?.syncRuns.some(
      (run) => run.operation === "facts" && run.status === "running",
    ) ?? false;

  const connectionBody = health.isError ? (
    <LabPanelState
      kind="error"
      title="Connection status unavailable"
      body="Previously loaded evidence remains unchanged."
      onRetry={() => void health.refetch()}
    />
  ) : health.data === undefined ? (
    <LabPanelState kind="loading" title="Loading connection" body="" />
  ) : connection === null ? (
    <p className="text-muted-foreground">
      No connection yet — run discovery once the environment credentials are
      set.
    </p>
  ) : (
    <div className="space-y-1 text-muted-foreground">
      <p>
        Status: <span className="text-foreground">{connection.status}</span>
      </p>
      <p>
        {connection.descriptiveName ?? "Unnamed account"} ·{" "}
        {connection.googleCustomerId ?? "no customer id"}
      </p>
      <p>
        {connection.timezone ?? "no timezone"} ·{" "}
        {connection.currencyCode ?? "no currency"}
      </p>
      <p>
        Last discovery: {formatAge(connection.lastDiscoverySyncedAt) ?? "never"}
      </p>
      <p>
        Last facts sync: {formatAge(connection.lastFactsSyncedAt) ?? "never"}
      </p>
      <p>
        Backfill: {formatAge(connection.backfillCompletedAt) ?? "not complete"}
      </p>
      {latestRunFailed && latestRun && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          Last run failed — {errorCodeCopy(latestRun.errorCode)}
          {latestRun.errorMessage ? ` (${latestRun.errorMessage})` : ""}
        </p>
      )}
    </div>
  );

  const probeBody = probeReport.isError ? (
    <LabPanelState
      kind="error"
      title="Probe report unavailable"
      body="Previously loaded evidence remains unchanged."
      onRetry={() => void probeReport.refetch()}
    />
  ) : probeReport.data === undefined ? (
    <LabPanelState kind="loading" title="Loading probe report" body="" />
  ) : probeReport.data === null ? (
    <p className="text-muted-foreground">No probe report yet.</p>
  ) : probeReport.data.status === "running" ? (
    <p className="text-muted-foreground">Probe running…</p>
  ) : probeReport.data.status === "failed" ? (
    <p className="flex items-center gap-1.5 text-destructive">
      <AlertCircle className="size-4 shrink-0" />
      Probe failed: {errorCodeCopy(probeReport.data.errorCode)}
    </p>
  ) : probeReport.data.status === "completed" && probeReport.data.summary ? (
    <div className="space-y-2">
      <p className="text-muted-foreground">
        {probeReport.data.summary.ordersWithAnyClickId} of{" "}
        {probeReport.data.summary.ordersScanned} orders carry a Google click
        ID · {probeReport.data.summary.journeyMissing} without a stored
        journey · {probeReport.data.summary.multiKindOrders} with multiple
        kinds
      </p>
      <p className="text-muted-foreground">
        Google-bucket orders without a click ID:{" "}
        {(probeReport.data.summary.byBucket.google?.orders ?? 0) -
          (probeReport.data.summary.byBucket.google?.withClickId ?? 0)}
      </p>
      <p className="text-muted-foreground">
        Non-google orders WITH a click ID:{" "}
        {Object.entries(probeReport.data.summary.byBucket).reduce(
          (total, [bucket, cell]) =>
            bucket === "google" ? total : total + cell.withClickId,
          0,
        )}
      </p>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bucket</TableHead>
              <TableHead>Orders</TableHead>
              <TableHead>With click ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Object.entries(probeReport.data.summary.byBucket).map(
              ([bucket, cell]) => (
                <TableRow key={bucket}>
                  <TableCell>{bucket}</TableCell>
                  <TableCell>{cell.orders}</TableCell>
                  <TableCell>{cell.withClickId}</TableCell>
                </TableRow>
              ),
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        gclid {probeReport.data.summary.byKind.gclid} · wbraid{" "}
        {probeReport.data.summary.byKind.wbraid} · gbraid{" "}
        {probeReport.data.summary.byKind.gbraid}
      </p>
      {probeReport.data.summary.paramKeyFingerprints.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Query keys seen on stored last-visit URLs (top{" "}
          {probeReport.data.summary.paramKeyFingerprints.length}):{" "}
          {probeReport.data.summary.paramKeyFingerprints
            .map(
              (fingerprint) =>
                `${fingerprint.hashed ? "•" : fingerprint.key} ×${fingerprint.count}`,
            )
            .join(" · ")}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          No query parameters at all on stored last-visit URLs — journey
          landing/referrer URLs are stored without query strings, so click IDs
          cannot be observed from this data.
        </p>
      )}
    </div>
  ) : (
    <p className="text-muted-foreground">No probe report yet.</p>
  );

  const currency = facts.data?.currencyCode ?? "USD";
  const campaignsBody = health.isError ? (
    <LabPanelState
      kind="error"
      title="Connection status unavailable"
      body="Previously loaded evidence remains unchanged."
      onRetry={() => void health.refetch()}
    />
  ) : health.data === undefined ? (
    <LabPanelState kind="loading" title="Loading connection" body="" />
  ) : connection === null ? (
    <p className="text-muted-foreground">Connect first.</p>
  ) : facts.isError ? (
    <LabPanelState
      kind="error"
      title="Campaign facts unavailable"
      body="Previously loaded evidence remains unchanged."
      onRetry={() => void facts.refetch()}
    />
  ) : facts.data === undefined ? (
    <LabPanelState kind="loading" title="Loading campaign facts" body="" />
  ) : facts.data.campaigns.length === 0 ? (
    <p className="text-muted-foreground">No facts yet — run a sync.</p>
  ) : (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campaign</TableHead>
              <TableHead>Spend</TableHead>
              <TableHead>Impr.</TableHead>
              <TableHead>Clicks</TableHead>
              <TableHead>Conv.</TableHead>
              <TableHead>Conv. value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {facts.data.campaigns.map((campaign) => (
              <TableRow key={campaign.campaignId}>
                <TableCell>{campaign.campaignName}</TableCell>
                <TableCell>
                  {formatMoney(campaign.costMicros / 1_000_000, currency) ??
                    "—"}
                </TableCell>
                <TableCell>{campaign.impressions}</TableCell>
                <TableCell>{campaign.clicks}</TableCell>
                <TableCell>{campaign.conversions}</TableCell>
                <TableCell>
                  {formatMoney(campaign.conversionsValue, currency) ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-medium">Total</TableCell>
              <TableCell>
                {formatMoney(
                  facts.data.campaigns.reduce(
                    (total, campaign) => total + campaign.costMicros,
                    0,
                  ) / 1_000_000,
                  currency,
                ) ?? "—"}
              </TableCell>
              <TableCell>
                {facts.data.campaigns.reduce(
                  (total, campaign) => total + campaign.impressions,
                  0,
                )}
              </TableCell>
              <TableCell>
                {facts.data.campaigns.reduce(
                  (total, campaign) => total + campaign.clicks,
                  0,
                )}
              </TableCell>
              <TableCell>
                {facts.data.campaigns.reduce(
                  (total, campaign) => total + campaign.conversions,
                  0,
                )}
              </TableCell>
              <TableCell>
                {formatMoney(
                  facts.data.campaigns.reduce(
                    (total, campaign) => total + campaign.conversionsValue,
                    0,
                  ),
                  currency,
                ) ?? "—"}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Reference: our google-bucket Shopify net sales for the same range is{" "}
        {formatCentsMoney(facts.data.googleBucketReference.netSalesCents, currency) ??
          "—"}{" "}
        across {facts.data.googleBucketReference.orderCount} orders (net of
        refunds dated in range — the order count and the money describe
        different sets). Different measurement systems — these numbers are
        not expected to reconcile. Google facts end at the account’s
        yesterday; the Shopify reference includes today.
      </p>
    </>
  );

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-3">
          <Button asChild size="sm" variant="ghost">
            <Link href="/attribution">
              <ArrowLeft className="size-4" />
              Attribution
            </Link>
          </Button>
          <h1 className="text-[15px] font-semibold tracking-tight">
            Google Ads Lab
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={runProbe.isPending || probeRunning}
            onClick={() => runProbe.mutate()}
          >
            {probeRunning ? "Probe running…" : "Run gclid probe"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={startDiscovery.isPending || discoveryRunning}
            onClick={() => startDiscovery.mutate()}
          >
            {discoveryRunning ? "Discovery running…" : "Run discovery"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={
              startFactsSync.isPending ||
              factsRunning ||
              connection?.status !== "ready"
            }
            onClick={() => startFactsSync.mutate()}
          >
            {factsRunning ? "Syncing facts…" : "Sync facts"}
          </Button>
        </div>
      </div>

      <section className="rounded-lg border p-4 text-sm">
        <h2 className="mb-2 text-[13px] font-semibold">Connection</h2>
        {connectionBody}
      </section>

      <section className="rounded-lg border p-4 text-sm">
        <h2 className="mb-2 text-[13px] font-semibold">gclid probe</h2>
        {probeBody}
      </section>

      <section className="rounded-lg border p-4 text-sm">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold">Google says · campaigns</h2>
          <div className="flex items-center gap-1.5">
            {RANGE_OPTIONS.map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => setRangeDays(days)}
                aria-pressed={rangeDays === days}
                className={`h-7 rounded-full border px-3 text-[12px] font-medium transition-colors ${
                  rangeDays === days
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {days}d
              </button>
            ))}
          </div>
        </div>
        {campaignsBody}
      </section>
    </div>
  );
}
