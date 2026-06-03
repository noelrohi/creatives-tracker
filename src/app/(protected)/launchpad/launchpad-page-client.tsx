"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Fingerprint, LockKeyhole, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { LAUNCHPAD_MAX_ITEMS } from "@/lib/launchpad-constants";
import { useTRPC } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

export function LaunchpadPageClient() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const runs = useQuery(trpc.launchpad.list.queryOptions({ limit: 50 }));

  const createRun = useMutation(
    trpc.launchpad.createValidationRun.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.launchpad.list.queryKey() });
        toast.success("Launchpad validation run recorded");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  function createDemoRun() {
    createRun.mutate({
      idempotencyKey: `demo_${crypto.randomUUID()}`,
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
                Inspect the publish ledger foundation before any live Meta side
                effects exist. Runs persist immutable manifests, hashes, audit
                context, and safety gates for future paused-ad publishing.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={createDemoRun}
            disabled={createRun.isPending}
            className="gap-1.5"
          >
            <Plus className="size-3.5" />
            {createRun.isPending ? "Recording…" : "Create demo run"}
          </Button>
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
                Create a demo run to verify the ledger without calling Meta.
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
