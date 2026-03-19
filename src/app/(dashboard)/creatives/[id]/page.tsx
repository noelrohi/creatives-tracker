"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { ArrowLeft, Copy, Layers, MoreHorizontalIcon, Pencil, Trash2 } from "lucide-react";
import { CreativeFormDialog } from "../creative-form-dialog";
import { TagInput } from "@/components/tag-input";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemMedia,
  ItemGroup,
} from "@/components/ui/item";

function prettify(s: string | null | undefined) {
  return s ? s.replace(/_/g, " ") : null;
}

export default function CreativeDetailPage() {
  const trpc = useTRPC();
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = params.id as string;

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const creative = useQuery(trpc.adCreative.getById.queryOptions({ id }));
  const landingPages = useQuery(trpc.landingPage.list.queryOptions());
  const linkedAdSets = useQuery(trpc.adSet.listByCreative.queryOptions({ adCreativeId: id }));

  const duplicateMutation = useMutation({
    ...trpc.adCreative.duplicate.mutationOptions(),
    onSuccess: (data) => {
      toast.success("Creative duplicated");
      router.push(`/creatives/${data.id}`);
    },
    onError: (error) => {
      toast.error(error.message || "Failed to duplicate");
    },
  });

  const deleteMutation = useMutation({
    ...trpc.adCreative.delete.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: trpc.adCreative.list.queryKey(),
      });
      toast.success("Creative deleted");
      router.push("/creatives");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete");
    },
  });

  if (creative.isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 pt-2">
        <div className="flex items-center gap-3">
          <Skeleton className="size-7 rounded" />
          <Skeleton className="h-7 w-56" />
        </div>
        <div className="space-y-1 pt-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-[120px_1fr] gap-4 px-2 py-[7px]"
            >
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (creative.isError || !creative.data) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24">
        <p className="text-sm text-muted-foreground">Creative not found.</p>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/creatives">Back to Creatives</Link>
        </Button>
      </div>
    );
  }

  const data = creative.data;

  const landingPageName =
    landingPages.data?.find((lp) => lp.id === data.landingPageId)?.name ?? null;

  const renderAsset = () => {
    if (!data.assetUrl) return <span className="text-muted-foreground">—</span>;
    if (data.assetUrl.match(/\.(mp4|webm|mov)(\?|$)/i)) {
      return <span className="text-sm text-muted-foreground">Video file</span>;
    }
    return (
      <img
        src={data.assetUrl}
        alt={data.name}
        className="h-32 rounded object-cover"
      />
    );
  };

  const rows: { label: string; content: React.ReactNode }[] = [
    {
      label: "Asset",
      content: renderAsset(),
    },
    {
      label: "Format",
      content: data.format ? (
        <span className="capitalize">{data.format}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
    {
      label: "Angle",
      content: data.angle ?? <span className="text-muted-foreground">—</span>,
    },
    {
      label: "Persona",
      content: data.persona ?? <span className="text-muted-foreground">—</span>,
    },
    {
      label: "Awareness",
      content: data.awarenessLevel ? (
        <span className="capitalize">{prettify(data.awarenessLevel)}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
    {
      label: "Hook",
      content: data.hook ?? <span className="text-muted-foreground">—</span>,
    },
    {
      label: "Tone",
      content:
        data.tone && data.tone.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {data.tone.map((t) => (
              <Badge key={t} variant="secondary" className="capitalize">
                {t.replace(/_/g, " ")}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      label: "CTA",
      content: data.cta ?? <span className="text-muted-foreground">—</span>,
    },
    {
      label: "Landing Page",
      content: landingPageName ?? (
        <span className="text-muted-foreground">—</span>
      ),
    },
    {
      label: "Notes",
      content: data.notes ? (
        <span className="whitespace-pre-wrap">{data.notes}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-2xl pt-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground/60 hover:text-foreground"
            asChild
          >
            <Link href="/creatives">
              <ArrowLeft className="size-3.5" />
            </Link>
          </Button>
          <h1 className="text-lg font-medium tracking-tight">
            {data.name || "Untitled"}
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
                onClick={() => duplicateMutation.mutate({ id })}
                disabled={duplicateMutation.isPending}
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

      {/* Properties */}
      <dl className="-mx-2 divide-y divide-border/50">
        {rows.map((row) => (
          <div
            key={row.label}
            className="grid grid-cols-[120px_1fr] items-baseline gap-4 py-2.5 px-2"
          >
            <dt className="text-sm text-muted-foreground">{row.label}</dt>
            <dd className="text-sm">{row.content}</dd>
          </div>
        ))}
      </dl>

      {/* Tags */}
      <div className="mt-6 px-2">
        <h3 className="text-sm font-medium text-muted-foreground mb-2">Tags</h3>
        <TagInput entityType="ad_creative" entityId={id} />
      </div>

      {/* Used in Ad Sets */}
      <div className="mt-6 px-2">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-medium">Used in Ad Sets</h3>
          {linkedAdSets.data && (
            <span className="text-[13px] tabular-nums text-muted-foreground/50">
              {linkedAdSets.data.length}
            </span>
          )}
        </div>
        {linkedAdSets.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground/60">
            Not used in any ad sets yet.
          </p>
        ) : (
          <ItemGroup>
            {linkedAdSets.data?.map((adSet) => (
              <Item key={adSet.id} asChild variant="outline" size="sm">
                <Link
                  href={`/ad-sets/${adSet.id}`}
                  className="hover:bg-muted/40 transition-colors"
                >
                  <ItemMedia variant="icon">
                    <div className="flex size-8 items-center justify-center rounded-md bg-violet-500/10">
                      <Layers className="size-3.5 text-violet-500" />
                    </div>
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{adSet.name}</ItemTitle>
                    <ItemDescription>
                      {adSet.campaignConfigName
                        ? `Campaign: ${adSet.campaignConfigName}`
                        : "No campaign linked"}
                    </ItemDescription>
                  </ItemContent>
                </Link>
              </Item>
            ))}
          </ItemGroup>
        )}
      </div>

      {/* Timestamp */}
      <p className="mt-8 text-[11px] text-muted-foreground/40 px-2">
        Created {new Date(data.createdAt).toLocaleDateString()} · Updated{" "}
        {new Date(data.updatedAt).toLocaleDateString()}
      </p>

      {/* Dialogs */}
      <CreativeFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        creative={{
          id: data.id,
          name: data.name,
          assetUrl: data.assetUrl,
          format: data.format,
          angle: data.angle,
          persona: data.persona,
          awarenessLevel: data.awarenessLevel,
          hook: data.hook,
          tone: data.tone,
          cta: data.cta,
          landingPageId: data.landingPageId,
          notes: data.notes,
        }}
        onSuccess={() => {
          queryClient.invalidateQueries({
            queryKey: trpc.adCreative.getById.queryKey({ id }),
          });
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete creative"
        description="This will permanently delete this creative and all its data."
        confirmLabel="Delete"
        onConfirm={() => deleteMutation.mutate({ id })}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
