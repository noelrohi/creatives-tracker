"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ButtonGroup } from "@/components/ui/button-group";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { toast } from "sonner";
import {
  ArrowLeft,
  MoreHorizontalIcon,
  Pencil,
  Plus,
  Trash2,
  Trophy,
  ArrowLeftRight,
} from "lucide-react";
import { ABTestFormDialog } from "../ab-test-form-dialog";

const statusColors: Record<string, string> = {
  running: "bg-green-100 text-green-700 border-green-200",
  completed: "bg-blue-100 text-blue-700 border-blue-200",
  paused: "bg-yellow-100 text-yellow-700 border-yellow-200",
};

export default function ABTestDetailPage() {
  const params = useParams();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const id = params.id as string;

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [addVariantOpen, setAddVariantOpen] = useState(false);
  const [variantAdSetId, setVariantAdSetId] = useState("");
  const [variantLabel, setVariantLabel] = useState("control");

  const test = useQuery(trpc.abTest.getById.queryOptions({ id }));
  const adSets = useQuery(trpc.adSet.list.queryOptions());

  const updateMutation = useMutation({
    ...trpc.abTest.update.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: trpc.abTest.getById.queryKey({ id }),
      });
    },
  });

  const deleteMutation = useMutation({
    ...trpc.abTest.delete.mutationOptions(),
    onSuccess: () => {
      toast.success("A/B test deleted");
      router.push("/ab-tests");
    },
    onError: (error) => toast.error(error.message),
  });

  const addVariantMutation = useMutation({
    ...trpc.abTest.addVariant.mutationOptions(),
    onSuccess: () => {
      toast.success("Variant added");
      queryClient.invalidateQueries({
        queryKey: trpc.abTest.getById.queryKey({ id }),
      });
      setAddVariantOpen(false);
      setVariantAdSetId("");
      setVariantLabel("control");
    },
    onError: (error) => toast.error(error.message),
  });

  const removeVariantMutation = useMutation({
    ...trpc.abTest.removeVariant.mutationOptions(),
    onSuccess: () => {
      toast.success("Variant removed");
      queryClient.invalidateQueries({
        queryKey: trpc.abTest.getById.queryKey({ id }),
      });
    },
  });

  if (test.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-10 w-64" />
        <div className="max-w-2xl space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (test.isError || !test.data) {
    return <div className="p-6 text-destructive">Failed to load A/B test.</div>;
  }

  const data = test.data;
  const variantAdSetIds = new Set(data.variants.map((v) => v.adSetId));
  const availableAdSets =
    adSets.data?.filter((a) => !variantAdSetIds.has(a.id)) ?? [];

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/ab-tests">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">
            {data.name}
          </h1>
          <Badge
            variant="outline"
            className={`capitalize ${statusColors[data.status] ?? ""}`}
          >
            {data.status}
          </Badge>
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
              <Button variant="outline" size="icon-sm" aria-label="More options">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {data.status !== "running" && (
                <DropdownMenuItem
                  onClick={() =>
                    updateMutation.mutate({ id, status: "running" })
                  }
                >
                  Resume
                </DropdownMenuItem>
              )}
              {data.status === "running" && (
                <DropdownMenuItem
                  onClick={() =>
                    updateMutation.mutate({ id, status: "paused" })
                  }
                >
                  Pause
                </DropdownMenuItem>
              )}
              {data.status !== "completed" && (
                <DropdownMenuItem
                  onClick={() =>
                    updateMutation.mutate({ id, status: "completed" })
                  }
                >
                  Mark Completed
                </DropdownMenuItem>
              )}
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

      {/* Details */}
      <div className="max-w-2xl divide-y rounded-lg border px-4">
        <div className="grid grid-cols-[140px_1fr] items-baseline gap-4 py-3">
          <span className="text-sm text-muted-foreground">Hypothesis</span>
          <span className="whitespace-pre-wrap text-sm">
            {data.hypothesis || "\u2014"}
          </span>
        </div>
        <div className="grid grid-cols-[140px_1fr] items-baseline gap-4 py-3">
          <span className="text-sm text-muted-foreground">Winner</span>
          <span className="text-sm">
            {data.winnerVariantId
              ? data.variants.find((v) => v.adSetId === data.winnerVariantId)
                  ?.adSetName ?? "\u2014"
              : "\u2014"}
          </span>
        </div>
      </div>

      {/* Variants */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Variants</h2>
          <div className="flex gap-2">
            {data.variants.length >= 2 && (
              <Button variant="outline" size="sm" asChild>
                <Link
                  href={`/compare?type=ad_set&a=${data.variants[0].adSetId}&b=${data.variants[1].adSetId}`}
                >
                  <ArrowLeftRight className="mr-1.5 size-3.5" />
                  Compare
                </Link>
              </Button>
            )}
            <Button size="sm" onClick={() => setAddVariantOpen(true)}>
              <Plus className="mr-1.5 size-3.5" /> Add Variant
            </Button>
          </div>
        </div>

        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Ad Set</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.variants.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-center text-muted-foreground"
                  >
                    No variants yet. Link ad sets as test variants.
                  </TableCell>
                </TableRow>
              ) : (
                data.variants.map((variant) => (
                  <TableRow key={variant.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{variant.label}</Badge>
                        {data.winnerVariantId === variant.adSetId && (
                          <Trophy className="size-3.5 text-amber-500" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/ad-sets/${variant.adSetId}`}
                        className="text-sm hover:underline"
                      >
                        {variant.adSetName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                          >
                            <MoreHorizontalIcon className="size-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() =>
                              updateMutation.mutate({
                                id,
                                winnerVariantId: variant.adSetId,
                              })
                            }
                          >
                            <Trophy className="size-3.5" /> Mark Winner
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() =>
                              removeVariantMutation.mutate({ id: variant.id })
                            }
                          >
                            <Trash2 className="size-3.5" /> Remove
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
      </div>

      {/* Add Variant Dialog */}
      <Dialog open={addVariantOpen} onOpenChange={setAddVariantOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Variant</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!variantAdSetId) {
                toast.error("Select an ad set");
                return;
              }
              addVariantMutation.mutate({
                abTestId: id,
                adSetId: variantAdSetId,
                label: variantLabel,
              });
            }}
            className="flex flex-col gap-5"
          >
            <FieldGroup>
              <Field>
                <FieldLabel>Ad Set</FieldLabel>
                <Select
                  value={variantAdSetId}
                  onValueChange={setVariantAdSetId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select ad set..." />
                  </SelectTrigger>
                  <SelectContent>
                    {availableAdSets.map((adSet) => (
                      <SelectItem key={adSet.id} value={adSet.id}>
                        {adSet.name}
                      </SelectItem>
                    ))}
                    {availableAdSets.length === 0 && (
                      <SelectItem value="__none__" disabled>
                        No available ad sets
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Label</FieldLabel>
                <Input
                  value={variantLabel}
                  onChange={(e) => setVariantLabel(e.target.value)}
                  placeholder="e.g. control, v1, v2"
                />
              </Field>
            </FieldGroup>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddVariantOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={addVariantMutation.isPending}>
                {addVariantMutation.isPending ? "Adding..." : "Add"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit & Delete Dialogs */}
      <ABTestFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        abTest={{
          id: data.id,
          name: data.name,
          hypothesis: data.hypothesis,
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete A/B test"
        description="This will permanently delete this A/B test and all its variant links."
        confirmLabel="Delete"
        onConfirm={() => deleteMutation.mutate({ id })}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
