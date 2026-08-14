"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeft } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatAge,
  formatCentsMoney,
} from "@/components/blocks/attribution/format";
import { addDays } from "@/lib/day";
import { getUserFacingErrorMessage } from "@/lib/errors";
import { useTRPC } from "@/lib/trpc/client";

const RANGE_OPTIONS = [7, 30, 90] as const;
type RangeDays = (typeof RANGE_OPTIONS)[number];

/** Short, human copy for the sync-run error codes the nightly schedule and
 * the manual triggers here can both leave behind. Unknown codes fall back to
 * the raw string rather than hiding the failure. */
const ERROR_CODE_COPY: Record<string, string> = {
  credential_invalid: "Credentials misconfigured — check the server environment",
  currency_changed: "Account currency changed — needs manual review",
  manager_account: "Configured account is a manager (MCC) — use a client account",
  customer_mismatch: "Configured customer ID does not match the account",
  provider_rejected: "Google rejected the request",
  retry_exhausted: "Retries exhausted",
  trigger_dispatch_failed: "Background dispatch failed",
};

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function currencyFormatter(currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  });
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

  const health = useQuery(trpc.googleAds.health.queryOptions());
  const probeReport = useQuery(trpc.googleAds.probeReport.queryOptions());
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
            disabled={runProbe.isPending}
            onClick={() => runProbe.mutate()}
          >
            Run gclid probe
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={startDiscovery.isPending}
            onClick={() => startDiscovery.mutate()}
          >
            Run discovery
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={startFactsSync.isPending || connection?.status !== "ready"}
            onClick={() => startFactsSync.mutate()}
          >
            Sync facts
          </Button>
        </div>
      </div>

      <section className="rounded-lg border p-4 text-sm">
        <h2 className="mb-2 text-[13px] font-semibold">Connection</h2>
        {connection === null ? (
          <p className="text-muted-foreground">
            No connection yet — run discovery once the environment
            credentials are set.
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
              <p className="text-xs text-muted-foreground">
                Last run failed —{" "}
                {latestRun.errorCode
                  ? (ERROR_CODE_COPY[latestRun.errorCode] ?? latestRun.errorCode)
                  : "unknown error"}
                {latestRun.errorMessage ? ` (${latestRun.errorMessage})` : ""}
              </p>
            )}
          </div>
        )}
      </section>

      <section className="rounded-lg border p-4 text-sm">
        <h2 className="mb-2 text-[13px] font-semibold">gclid probe</h2>
        {probeReport.data === undefined ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : probeReport.data === null ? (
          <p className="text-muted-foreground">No probe report yet.</p>
        ) : probeReport.data.status === "running" ? (
          <p className="text-muted-foreground">Probe running…</p>
        ) : probeReport.data.status === "failed" ? (
          <p className="text-muted-foreground">
            Probe failed: {probeReport.data.errorCode ?? "unknown"}
          </p>
        ) : probeReport.data.status === "completed" && probeReport.data.summary ? (
          <div className="space-y-2">
            <p className="text-muted-foreground">
              {probeReport.data.summary.ordersWithAnyClickId} of{" "}
              {probeReport.data.summary.ordersScanned} orders carry a Google
              click ID · {probeReport.data.summary.journeyMissing} without a
              stored journey · {probeReport.data.summary.multiKindOrders} with
              multiple kinds
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
          </div>
        ) : (
          <p className="text-muted-foreground">No probe report yet.</p>
        )}
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
        {connection === null ? (
          <p className="text-muted-foreground">Connect first.</p>
        ) : facts.data === undefined ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : facts.data.campaigns.length === 0 ? (
          <p className="text-muted-foreground">No facts yet — run a sync.</p>
        ) : (
          <>
            {(() => {
              const money = currencyFormatter(facts.data.currencyCode ?? "USD");
              return (
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
                            {money.format(campaign.costMicros / 1_000_000)}
                          </TableCell>
                          <TableCell>{campaign.impressions}</TableCell>
                          <TableCell>{campaign.clicks}</TableCell>
                          <TableCell>{campaign.conversions}</TableCell>
                          <TableCell>
                            {money.format(campaign.conversionsValue)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              );
            })()}
            <p className="mt-2 text-xs text-muted-foreground">
              Reference: our google-bucket Shopify net sales for the same
              range is{" "}
              {formatCentsMoney(
                facts.data.googleBucketReference.netSalesCents,
                facts.data.currencyCode ?? "USD",
              )}{" "}
              across {facts.data.googleBucketReference.orderCount} orders (net
              of refunds dated in range — the order count and the money
              describe different sets). Different measurement systems — these
              numbers are not expected to reconcile.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
