"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Trash2, ArrowLeft, MoreHorizontalIcon, Pencil, Plus, Upload, Copy } from "lucide-react";
import { AdSetFormDialog } from "../ad-set-form-dialog";
import { TagInput } from "@/components/tag-input";
import { AddPerformanceLogDialog } from "../add-performance-log-dialog";

export default function AdSetDetailPage() {
  const params = useParams();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const id = params.id as string;

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [addLogOpen, setAddLogOpen] = useState(false);

  const adSet = useQuery(trpc.adSet.getById.queryOptions({ id }));
  const logs = useQuery(trpc.performanceLog.listByAdSet.queryOptions({ adSetId: id }));

  const duplicateMutation = useMutation({
    ...trpc.adSet.duplicate.mutationOptions(),
    onSuccess: (data) => {
      toast.success("Ad set duplicated");
      router.push(`/ad-sets/${data.id}`);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const deleteMutation = useMutation({
    ...trpc.adSet.delete.mutationOptions(),
    onSuccess: () => {
      toast.success("Ad set deleted");
      router.push("/ad-sets");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  if (adSet.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-10 w-64" />
        <div className="max-w-2xl space-y-0 divide-y rounded-lg border px-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="grid grid-cols-[140px_1fr] items-baseline gap-4 py-3">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-40" />
            </div>
          ))}
        </div>
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (adSet.isError || !adSet.data) {
    return <div className="p-6 text-destructive">Failed to load ad set.</div>;
  }

  const data = adSet.data;

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/ad-sets">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">
            {data.name || "Untitled Ad Set"}
          </h1>
        </div>
        <ButtonGroup>
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil className="mr-1.5 size-3.5" /> Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm" aria-label="More options">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => duplicateMutation.mutate({ id })}
                disabled={duplicateMutation.isPending}
              >
                <Copy /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      </div>

      {/* Read-only detail */}
      <div className="max-w-2xl divide-y rounded-lg border px-4">
        <div className="grid grid-cols-[140px_1fr] items-baseline gap-4 py-3">
          <span className="text-sm text-muted-foreground">Campaign</span>
          {data.campaignConfigId ? (
            <Link
              href={`/campaigns/${data.campaignConfigId}`}
              className="text-sm hover:underline"
            >
              {data.campaignConfigName}
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground/40">{"\u2014"}</span>
          )}
        </div>
        <div className="grid grid-cols-[140px_1fr] items-baseline gap-4 py-3">
          <span className="text-sm text-muted-foreground">Creative</span>
          {data.adCreativeId ? (
            <Link
              href={`/creatives/${data.adCreativeId}`}
              className="text-sm hover:underline"
            >
              {data.adCreativeName}
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground/40">{"\u2014"}</span>
          )}
        </div>
        <div className="grid grid-cols-[140px_1fr] items-baseline gap-4 py-3">
          <span className="text-sm text-muted-foreground">Landing Page</span>
          {data.landingPageVersionId ? (
            <span className="text-sm">
              {data.landingPageName} v{data.landingPageVersion}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground/40">{"\u2014"}</span>
          )}
        </div>
        <div className="grid grid-cols-[140px_1fr] items-baseline gap-4 py-3">
          <span className="text-sm text-muted-foreground">Notes</span>
          <span className="whitespace-pre-wrap text-sm">
            {data.notes || "\u2014"}
          </span>
        </div>
      </div>

      {/* Tags */}
      <div className="max-w-2xl">
        <h3 className="text-sm font-medium text-muted-foreground mb-2">Tags</h3>
        <TagInput entityType="ad_set" entityId={id} />
      </div>

      {/* Performance Logs */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Performance Logs</h2>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href={`/ad-sets/${id}/import`}>
                <Upload className="mr-1.5 size-3.5" /> Import CSV
              </Link>
            </Button>
            <Button onClick={() => setAddLogOpen(true)} size="sm">
              <Plus className="mr-1.5 size-3.5" /> Add Log
            </Button>
          </div>
        </div>

        <div className="rounded-lg border overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date Range</TableHead>
                <TableHead>ROAS</TableHead>
                <TableHead>CPA</TableHead>
                <TableHead>CTR</TableHead>
                <TableHead>Conv Rate</TableHead>
                <TableHead>Spend</TableHead>
                <TableHead>Conv</TableHead>
                <TableHead>Impr</TableHead>
                <TableHead>Reach</TableHead>
                <TableHead>Freq</TableHead>
                <TableHead>CPM</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.data?.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="whitespace-nowrap">
                    {log.dateStart} &mdash; {log.dateEnd}
                  </TableCell>
                  <TableCell>{log.roas ?? "\u2014"}</TableCell>
                  <TableCell>{log.cpa ? `$${log.cpa}` : "\u2014"}</TableCell>
                  <TableCell>{log.ctr ? `${log.ctr}%` : "\u2014"}</TableCell>
                  <TableCell>
                    {log.conversionRate ? `${log.conversionRate}%` : "\u2014"}
                  </TableCell>
                  <TableCell>{log.spend ? `$${log.spend}` : "\u2014"}</TableCell>
                  <TableCell>{log.conversions ?? "\u2014"}</TableCell>
                  <TableCell>{log.impressions?.toLocaleString() ?? "\u2014"}</TableCell>
                  <TableCell>{log.reach?.toLocaleString() ?? "\u2014"}</TableCell>
                  <TableCell>{log.frequency ?? "\u2014"}</TableCell>
                  <TableCell>{log.cpm ? `$${log.cpm}` : "\u2014"}</TableCell>
                </TableRow>
              ))}
              {logs.data?.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={11}
                    className="text-center text-muted-foreground"
                  >
                    No performance logs yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Dialogs */}
      <AdSetFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        adSet={{
          id: data.id,
          name: data.name,
          adCreativeId: data.adCreativeId,
          landingPageVersionId: data.landingPageVersionId,
          campaignConfigId: data.campaignConfigId,
          notes: data.notes,
        }}
        onSuccess={() => {
          queryClient.invalidateQueries({
            queryKey: trpc.adSet.getById.queryKey({ id }),
          });
        }}
      />
      <AddPerformanceLogDialog
        open={addLogOpen}
        onOpenChange={setAddLogOpen}
        adSetId={id}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete ad set"
        description="This will permanently delete this ad set and its performance logs."
        confirmLabel="Delete"
        onConfirm={() => deleteMutation.mutate({ id })}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
