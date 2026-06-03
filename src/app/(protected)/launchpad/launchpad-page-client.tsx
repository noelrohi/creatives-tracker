"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Fingerprint,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Target,
} from "lucide-react";
import { toast } from "sonner";
import { LAUNCHPAD_MAX_ITEMS } from "@/lib/launchpad-constants";
import { useTRPC } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function shortHash(hash: string) {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function readinessLabel(reason: string) {
  switch (reason) {
    case "missing_access_token":
      return "missing access token";
    case "missing_facebook_page_id":
      return "missing Facebook Page ID";
    default:
      return reason.replace(/_/g, " ");
  }
}

export function LaunchpadPageClient() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedAdSetId, setSelectedAdSetId] = useState("");

  const runs = useQuery(trpc.launchpad.list.queryOptions({ limit: 50 }));
  const destinationAccounts = useQuery(
    trpc.launchpad.destinationAccounts.queryOptions(),
  );
  const selectedAccount = destinationAccounts.data?.find(
    (account) => account.id === selectedAccountId,
  );
  const eligibleAdSets = useQuery({
    ...trpc.launchpad.eligibleAdSets.queryOptions({
      accountId: selectedAccountId || "__no_account_selected__",
    }),
    enabled: Boolean(selectedAccountId && selectedAccount?.canPublish),
  });
  const selectedAdSet = eligibleAdSets.data?.find(
    (adSet) => adSet.id === selectedAdSetId,
  );
  const destinationContext = useQuery({
    ...trpc.launchpad.destinationContext.queryOptions({
      accountId: selectedAccountId || "__no_account_selected__",
      adSetId: selectedAdSetId || "__no_ad_set_selected__",
    }),
    enabled: Boolean(selectedAccountId && selectedAdSetId),
  });

  const createRun = useMutation(
    trpc.launchpad.createValidationRun.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.launchpad.list.queryKey() });
        toast.success("Launchpad validation run recorded");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  function handleAccountChange(accountId: string) {
    setSelectedAccountId(accountId);
    setSelectedAdSetId("");
  }

  function createDemoRun() {
    if (!selectedAccountId || !selectedAdSetId) {
      toast.error("Select an eligible Meta destination first.");
      return;
    }

    createRun.mutate({
      idempotencyKey: `demo_${crypto.randomUUID()}`,
      actor: { accountId: selectedAccountId },
      destination: { adSetId: selectedAdSetId },
      items: [
        {
          adName: "Launchpad ledger demo / paused static ad",
          destinationUrl:
            "https://example.com/products?utm_source=meta&utm_medium=paid_social",
          cta: "SHOP_NOW",
          requestedStatus: "PAUSED",
        },
      ],
    });
  }

  const destinationReady = Boolean(selectedAccountId && selectedAdSetId);

  return (
    <div className="flex flex-col gap-6">
      <div className="relative overflow-hidden rounded-2xl border bg-card p-6 shadow-sm">
        <div className="pointer-events-none absolute right-0 top-0 h-40 w-40 translate-x-12 -translate-y-12 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="max-w-2xl space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="gap-1.5">
                <ShieldCheck className="size-3" /> Dry-run ledger
              </Badge>
              <Badge variant="secondary">Meta calls disabled</Badge>
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Creative Launchpad
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Select one eligible synced Meta destination before recording a
                Launchpad validation run. Destination context is read-only: no
                budget, targeting, pixel, placement, or optimization controls.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={createDemoRun}
            disabled={createRun.isPending || !destinationReady}
            className="gap-1.5"
          >
            <Plus className="size-3.5" />
            {createRun.isPending ? "Recording…" : "Create demo run"}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border bg-card">
        <div className="border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Target className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Publishing destination</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose a Meta ad account with a stored token and default Facebook
            Page ID, then one linked synced ad set with a Meta ad set ID.
          </p>
        </div>
        <div className="grid gap-4 p-4 lg:grid-cols-[1fr_1fr_1.3fr]">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Account
            </label>
            <Select
              value={selectedAccountId}
              onValueChange={handleAccountChange}
              disabled={destinationAccounts.isLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select account…" />
              </SelectTrigger>
              <SelectContent>
                {destinationAccounts.data?.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    <span>{account.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {account.metaAccountId}
                    </span>
                    {!account.canPublish ? (
                      <span className="ml-2 text-xs text-amber-600">
                        needs setup
                      </span>
                    ) : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedAccount && !selectedAccount.canPublish ? (
              <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Account setup incomplete: {selectedAccount.ineligibleReasons.map(readinessLabel).join(", ")}.
                </span>
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Eligible ad set
            </label>
            <Select
              value={selectedAdSetId}
              onValueChange={setSelectedAdSetId}
              disabled={!selectedAccount?.canPublish || eligibleAdSets.isLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select ad set…" />
              </SelectTrigger>
              <SelectContent>
                {eligibleAdSets.data?.map((adSet) => (
                  <SelectItem key={adSet.id} value={adSet.id}>
                    <span>{adSet.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {adSet.metaId}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedAccount?.canPublish && eligibleAdSets.data?.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No eligible linked ad sets for this account yet.
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="mb-2 flex items-center gap-2">
              {destinationContext.data ? (
                <CheckCircle2 className="size-4 text-emerald-600" />
              ) : (
                <ShieldCheck className="size-4 text-muted-foreground" />
              )}
              <p className="text-sm font-medium">Read-only context</p>
            </div>
            {destinationContext.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : destinationContext.data ? (
              <dl className="grid gap-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Account</dt>
                  <dd className="text-right font-medium">
                    {destinationContext.data.account.name}
                    <span className="ml-1 text-muted-foreground">
                      {destinationContext.data.account.metaAccountId}
                    </span>
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Facebook Page</dt>
                  <dd className="font-mono">
                    {destinationContext.data.account.defaultFacebookPageId}
                  </dd>
                </div>
                {destinationContext.data.account.defaultInstagramActorId ? (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Instagram actor</dt>
                    <dd className="font-mono">
                      {destinationContext.data.account.defaultInstagramActorId}
                    </dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Campaign</dt>
                  <dd className="text-right">
                    {destinationContext.data.adSet.campaign.name ?? "Unknown"}
                    {destinationContext.data.adSet.campaign.metaId ? (
                      <span className="ml-1 font-mono text-muted-foreground">
                        {destinationContext.data.adSet.campaign.metaId}
                      </span>
                    ) : null}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Ad set</dt>
                  <dd className="text-right">
                    {selectedAdSet?.name ?? destinationContext.data.adSet.name}
                    <span className="ml-1 font-mono text-muted-foreground">
                      {destinationContext.data.adSet.metaId}
                    </span>
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Statuses</dt>
                  <dd className="capitalize">
                    {destinationContext.data.adSet.status}
                    {destinationContext.data.adSet.campaign.status ? (
                      <span className="text-muted-foreground">
                        {` · campaign ${destinationContext.data.adSet.campaign.status}`}
                      </span>
                    ) : null}
                  </dd>
                </div>
              </dl>
            ) : destinationContext.error ? (
              <p className="text-xs text-destructive">
                {destinationContext.error.message}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Select an account and eligible ad set to preview the exact
                Launchpad destination context.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-xl border bg-card p-4">
          <LockKeyhole className="mb-3 size-4 text-primary" />
          <p className="text-sm font-medium">Immutable manifest</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Hash-locked run and item payloads.
          </p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <Archive className="mb-3 size-4 text-primary" />
          <p className="text-sm font-medium">Durable states</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Validation through manual intervention outcomes.
          </p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <Fingerprint className="mb-3 size-4 text-primary" />
          <p className="text-sm font-medium">Idempotent by design</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Run and item dedupe keys are persisted.
          </p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <ShieldCheck className="mb-3 size-4 text-primary" />
          <p className="text-sm font-medium">{LAUNCHPAD_MAX_ITEMS}-item cap</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Backend-enforced, paused-only safety contract.
          </p>
        </div>
      </div>

      <div className="rounded-xl border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Validation runs</h2>
          <p className="text-xs text-muted-foreground">
            Non-publishing records only; live publish is intentionally gated off.
          </p>
        </div>
        {runs.isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : runs.data?.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-14 text-center">
            <div className="rounded-full border bg-muted/40 p-3">
              <ShieldCheck className="size-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">No Launchpad runs yet</p>
              <p className="text-xs text-muted-foreground">
                Select a destination and create a demo run to verify the ledger
                without calling Meta.
              </p>
            </div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Manifest hash</TableHead>
                <TableHead>Live env at validation</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data?.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {statusLabel(run.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm tabular-nums">
                      {run.itemCount}/{run.maxItemCap}
                    </span>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs text-muted-foreground">
                      {shortHash(run.manifestHash)}
                    </code>
                  </TableCell>
                  <TableCell>
                    {run.livePublishEnabledAtValidation ? (
                      <Badge>Enabled</Badge>
                    ) : (
                      <Badge variant="secondary">Disabled</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(run.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
