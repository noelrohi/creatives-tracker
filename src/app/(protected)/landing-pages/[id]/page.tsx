"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { toast } from "sonner";
import { ArrowLeft, Copy, MoreHorizontalIcon, Pencil, Plus, Trash2 } from "lucide-react";
import { LandingPageFormDialog } from "@/components/blocks/landing-pages/landing-page-form-dialog";
import { TagInput } from "@/components/tag-input";
import { VersionDialog } from "@/components/blocks/landing-pages/version-dialog";

export default function LandingPageDetailPage() {
  const trpc = useTRPC();
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = params.id as string;

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [addVersionOpen, setAddVersionOpen] = useState(false);
  const [editingVersion, setEditingVersion] = useState<{
    id: string;
    version: number;
    url: string | null;
    screenshotUrl: string | null;
    pageType: string;
    heroCopy: string;
    benefits: string[];
    socialProofType: string[];
    funnelPosition: string;
    notes: string | null;
  } | null>(null);

  const landingPage = useQuery(trpc.landingPage.getById.queryOptions({ id }));

  const duplicatePageMutation = useMutation({
    ...trpc.landingPage.duplicate.mutationOptions(),
    onSuccess: (data) => {
      toast.success("Landing page duplicated");
      router.push(`/landing-pages/${data.id}`);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const duplicateVersionMutation = useMutation({
    ...trpc.landingPage.duplicateVersion.mutationOptions(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: trpc.landingPage.getById.queryKey({ id }),
      });
      toast.success(`Duplicated as v${data.version}`);
      setEditingVersion(data);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const deleteMutation = useMutation({
    ...trpc.landingPage.delete.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.landingPage.list.queryKey() });
      toast.success("Landing page deleted");
      router.push("/landing-pages");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete landing page");
    },
  });

  if (landingPage.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-8" />
            <Skeleton className="h-8 w-64" />
          </div>
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="rounded-lg border p-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-[140px_1fr] items-center gap-3 px-3 py-3"
            >
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-7 w-full" />
            </div>
          ))}
        </div>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (landingPage.isError || !landingPage.data) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16">
        <p className="text-muted-foreground">Landing page not found.</p>
        <Button variant="outline" asChild>
          <Link href="/landing-pages">Back to Landing Pages</Link>
        </Button>
      </div>
    );
  }

  const data = landingPage.data;

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/landing-pages">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">
            {data.name || "Untitled Landing Page"}
          </h1>
        </div>
        <ButtonGroup>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditOpen(true)}
          >
            <Pencil className="mr-1.5 size-3.5" /> Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="More options"
              >
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => duplicatePageMutation.mutate({ id })}
                disabled={duplicatePageMutation.isPending}
              >
                <Copy /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      </div>

      {/* Read-only fields */}
      <dl className="rounded-lg border divide-y">
        <div className="grid grid-cols-[140px_1fr] items-center gap-3 px-3 py-3">
          <dt className="text-sm text-muted-foreground">URL</dt>
          <dd className="text-sm">{data.url || "\u2014"}</dd>
        </div>
      </dl>

      {/* Metadata */}
      <p className="text-xs text-muted-foreground px-3">
        Created {new Date(data.createdAt).toLocaleDateString()} · Updated{" "}
        {new Date(data.updatedAt).toLocaleDateString()}
      </p>

      {/* Tags */}
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-2">Tags</h3>
        <TagInput entityType="landing_page" entityId={id} />
      </div>

      {/* Versions */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Versions</h2>
        <Button size="sm" onClick={() => setAddVersionOpen(true)}>
          <Plus className="mr-2 size-4" /> Add Version
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Page Type</TableHead>
              <TableHead>Hero Copy</TableHead>
              <TableHead>Funnel Position</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.versions.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground"
                >
                  No versions yet
                </TableCell>
              </TableRow>
            ) : (
              data.versions.map((version) => (
                <TableRow key={version.id}>
                  <TableCell className="font-medium">
                    v{version.version}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {version.pageType.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate">
                    {version.heroCopy}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {version.funnelPosition.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(version.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="w-10">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="size-7">
                          <MoreHorizontalIcon className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditingVersion(version)}>
                          <Pencil className="size-3.5" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => duplicateVersionMutation.mutate({ id: version.id })}
                          disabled={duplicateVersionMutation.isPending}
                        >
                          <Copy className="size-3.5" />
                          Duplicate
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Dialogs */}
      <LandingPageFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        landingPage={{
          id: data.id,
          name: data.name,
          url: data.url,
        }}
      />
      <VersionDialog
        open={addVersionOpen}
        onOpenChange={setAddVersionOpen}
        landingPageId={id}
      />
      <VersionDialog
        open={!!editingVersion}
        onOpenChange={(open) => { if (!open) setEditingVersion(null); }}
        landingPageId={id}
        version={editingVersion ?? undefined}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete landing page"
        description="This will permanently delete this landing page and all its versions."
        confirmLabel="Delete"
        onConfirm={() => deleteMutation.mutate({ id })}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
