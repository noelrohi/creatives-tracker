"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
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
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CampaignFormDialog } from "../campaign-form-dialog";
import { toast } from "sonner";
import { ArrowLeft, MoreHorizontalIcon, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";

export default function CampaignDetailPage() {
  const params = useParams();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const id = params.id as string;

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const campaign = useQuery(trpc.campaignConfig.getById.queryOptions({ id }));

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
        <div className="flex max-w-2xl flex-col gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
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

  const empty = (
    <span className="text-muted-foreground/40">&mdash;</span>
  );

  const renderArray = (arr: string[] | null) => {
    if (!arr || arr.length === 0) return empty;
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

  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: "Objective",
      value: data.objective ? (
        <span className="capitalize">
          {data.objective.replace(/_/g, " ")}
        </span>
      ) : (
        empty
      ),
    },
    {
      label: "Cost Cap",
      value: data.costCap || empty,
    },
    {
      label: "Targeting",
      value: renderArray(data.targetingMethod),
    },
    {
      label: "Demographics",
      value: data.demographics || empty,
    },
    {
      label: "Geos",
      value: renderArray(data.geos),
    },
    {
      label: "Daily Budget",
      value: data.dailyBudget ? `$${data.dailyBudget}` : empty,
    },
    {
      label: "Placements",
      value: renderArray(data.placements),
    },
    {
      label: "Notes",
      value: data.notes ? (
        <span className="whitespace-pre-wrap">{data.notes}</span>
      ) : (
        empty
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
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
                variant="destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      </div>

      <dl className="max-w-2xl divide-y rounded-lg border px-4">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline gap-4 py-3">
            <dt className="w-[120px] shrink-0 text-sm text-muted-foreground">
              {row.label}
            </dt>
            <dd className="min-w-0 text-sm">{row.value}</dd>
          </div>
        ))}
      </dl>

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
