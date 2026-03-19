"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ButtonGroup } from "@/components/ui/button-group";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CampaignFormDialog } from "../campaign-form-dialog";
import { TagInput } from "@/components/tag-input";
import { toast } from "sonner";
import { ArrowLeft, Copy, Layers, MoreHorizontalIcon, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemMedia,
  ItemGroup,
} from "@/components/ui/item";

export default function CampaignDetailPage() {
  const params = useParams();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const id = params.id as string;

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const campaign = useQuery(trpc.campaignConfig.getById.queryOptions({ id }));
  const linkedAdSets = useQuery(trpc.adSet.listByCampaign.queryOptions({ campaignConfigId: id }));

  const duplicateMutation = useMutation({
    ...trpc.campaignConfig.duplicate.mutationOptions(),
    onSuccess: (data) => {
      toast.success("Campaign duplicated");
      router.push(`/campaigns/${data.id}`);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const deleteMutation = useMutation({
    ...trpc.campaignConfig.delete.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: trpc.campaignConfig.list.queryKey(),
      });
      toast.success("Campaign deleted");
      router.push("/campaigns");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  if (campaign.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-8 w-48" />
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (campaign.isError || !campaign.data) {
    return (
      <div className="p-6 text-destructive">Failed to load campaign.</div>
    );
  }

  const data = campaign.data;

  const renderArray = (arr: string[] | null) => {
    if (!arr || arr.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1">
        {arr.map((item) => (
          <Badge key={item} variant="secondary" className="capitalize">
            {item.replace(/_/g, " ")}
          </Badge>
        ))}
      </div>
    );
  };

  const detailRows = ([
    data.objective
      ? {
          label: "Objective",
          value: (
            <span className="capitalize">
              {data.objective.replace(/_/g, " ")}
            </span>
          ),
        }
      : null,
    data.dailyBudget
      ? { label: "Daily Budget", value: `$${data.dailyBudget}` }
      : null,
    data.costCap ? { label: "Cost Cap", value: data.costCap } : null,
    data.targetingMethod?.length
      ? { label: "Targeting", value: renderArray(data.targetingMethod) }
      : null,
    data.demographics
      ? { label: "Demographics", value: data.demographics }
      : null,
    data.geos?.length
      ? { label: "Geos", value: renderArray(data.geos) }
      : null,
    data.placements?.length
      ? { label: "Placements", value: renderArray(data.placements) }
      : null,
    data.notes
      ? {
          label: "Notes",
          value: <span className="whitespace-pre-wrap">{data.notes}</span>,
        }
      : null,
  ] as ({ label: string; value: React.ReactNode } | null)[]).filter(
    (r): r is { label: string; value: React.ReactNode } => r !== null,
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/campaigns">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">
            {data.name || "Untitled Campaign"}
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

      {/* Tabs */}
      <Tabs defaultValue="ad-sets">
        <TabsList variant="line">
          <TabsTrigger value="ad-sets">
            Ad Sets
            {linkedAdSets.data && (
              <span className="ml-1 text-xs tabular-nums text-muted-foreground/50">
                {linkedAdSets.data.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>

        <TabsContent value="ad-sets" className="pt-4">
          {linkedAdSets.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          ) : linkedAdSets.data?.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16">
              <div className="flex size-10 items-center justify-center rounded-full bg-violet-500/10">
                <Layers className="size-4 text-violet-500/50" />
              </div>
              <p className="text-sm text-muted-foreground">
                No ad sets linked to this campaign yet.
              </p>
            </div>
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
                        {[
                          adSet.adCreativeName,
                          adSet.landingPageName
                            ? `${adSet.landingPageName}${adSet.landingPageVersion ? ` v${adSet.landingPageVersion}` : ""}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" → ") || "No links yet"}
                      </ItemDescription>
                    </ItemContent>
                  </Link>
                </Item>
              ))}
            </ItemGroup>
          )}
        </TabsContent>

        <TabsContent value="details" className="pt-4 flex flex-col gap-6">
          {detailRows.length > 0 ? (
            <div className="max-w-2xl divide-y rounded-lg border px-4">
              {detailRows.map((row) => (
                <div key={row.label} className="flex items-baseline gap-4 py-3">
                  <dt className="w-[120px] shrink-0 text-sm text-muted-foreground">
                    {row.label}
                  </dt>
                  <dd className="min-w-0 text-sm">{row.value}</dd>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground/50">
              No details configured yet.
            </p>
          )}

          {/* Tags */}
          <div className="max-w-2xl">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Tags</h3>
            <TagInput entityType="campaign_config" entityId={id} />
          </div>
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <CampaignFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        campaign={data}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete campaign"
        description="This will permanently delete this campaign configuration."
        confirmLabel="Delete"
        onConfirm={() => deleteMutation.mutate({ id })}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
