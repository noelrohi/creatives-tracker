"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { useTRPC } from "@/lib/trpc/client";
import { authClient } from "@/lib/auth-client";
import { isPrivilegedOrgRole } from "@/lib/organization-access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, MoreHorizontal, Pencil, Trash2 } from "@/components/icons";
import { toast } from "sonner";

interface TeamForm {
  name: string;
  notes: string;
}

export default function TeamsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: session } = authClient.useSession();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const orgId = activeOrg?.id;

  const { data: fullOrg } = useQuery({
    queryKey: ["org-full", orgId],
    queryFn: async () => {
      if (!orgId) return null;
      const { data } = await authClient.organization.getFullOrganization({
        query: { organizationId: orgId },
      });
      return data;
    },
    enabled: !!orgId,
  });

  const currentUserRole = fullOrg?.members?.find(
    (m: { userId: string; role: string }) => m.userId === session?.user?.id,
  )?.role;
  const canWrite = isPrivilegedOrgRole(
    currentUserRole === "owner" || currentUserRole === "admin"
      ? currentUserRole
      : null,
  );

  const teamsList = useQuery(trpc.team.list.queryOptions());

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const form = useForm<TeamForm>({
    defaultValues: { name: "", notes: "" },
  });

  const createMutation = useMutation(
    trpc.team.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.team.list.queryKey() });
        toast.success("Team created");
        closeDialog();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const updateMutation = useMutation(
    trpc.team.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.team.list.queryKey() });
        toast.success("Team updated");
        closeDialog();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const deleteMutation = useMutation(
    trpc.team.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.team.list.queryKey() });
        toast.success("Team deleted");
        setDeleteId(null);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  function openCreate() {
    setEditingId(null);
    form.reset({ name: "", notes: "" });
    setDialogOpen(true);
  }

  function openEdit(team: { id: string; name: string; notes: string | null }) {
    setEditingId(team.id);
    form.reset({ name: team.name, notes: team.notes ?? "" });
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingId(null);
  }

  function onSubmit(values: TeamForm) {
    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        name: values.name,
        notes: values.notes || null,
      });
    } else {
      createMutation.mutate({
        name: values.name,
        notes: values.notes || undefined,
      });
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Teams</h1>
          <p className="text-sm text-muted-foreground">
            Manage teams within your organization.
          </p>
        </div>
        {canWrite && (
          <Button size="sm" onClick={openCreate} className="gap-1.5">
            <Plus className="size-3.5" /> Add Team
          </Button>
        )}
      </div>

      {teamsList.isLoading ? (
        <div className="divide-y rounded-lg border">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-48" />
              <div className="flex-1" />
              <Skeleton className="size-8" />
            </div>
          ))}
        </div>
      ) : teamsList.data?.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-16">
          <div className="text-center">
            <p className="text-sm text-muted-foreground">No teams yet</p>
            <p className="text-[13px] text-muted-foreground/40">
              {canWrite
                ? "Create a team to organize your work."
                : "No teams have been created yet."}
            </p>
          </div>
          {canWrite && (
            <Button
              size="sm"
              variant="outline"
              onClick={openCreate}
              className="gap-1.5"
            >
              <Plus className="size-3.5" /> Add Team
            </Button>
          )}
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Notes</TableHead>
                {canWrite && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {teamsList.data?.map((team) => (
                <TableRow key={team.id}>
                  <TableCell className="font-medium">{team.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {team.notes || (
                      <span className="text-muted-foreground/30">&mdash;</span>
                    )}
                  </TableCell>
                  {canWrite && (
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEdit(team)}>
                            <Pencil /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setDeleteId(team.id)}
                          >
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {canWrite && (
        <>
          <Dialog
            open={dialogOpen}
            onOpenChange={(open) => {
              if (!open) closeDialog();
              else setDialogOpen(true);
            }}
          >
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {editingId ? "Edit Team" : "Add Team"}
                </DialogTitle>
              </DialogHeader>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="grid gap-4"
              >
                <Field>
                  <FieldLabel>Name</FieldLabel>
                  <Input
                    {...form.register("name", { required: true })}
                    placeholder="e.g., In-house creative"
                  />
                </Field>
                <Field>
                  <FieldLabel>Notes (optional)</FieldLabel>
                  <Input
                    {...form.register("notes")}
                    placeholder="Any notes..."
                  />
                </Field>
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="outline" onClick={closeDialog}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isPending}>
                    {isPending ? "Saving..." : editingId ? "Save" : "Add"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>

          <ConfirmDialog
            open={!!deleteId}
            onOpenChange={(open) => {
              if (!open) setDeleteId(null);
            }}
            title="Delete team"
            description="This will permanently remove this team."
            confirmLabel="Delete"
            onConfirm={() =>
              deleteId && deleteMutation.mutate({ id: deleteId })
            }
            loading={deleteMutation.isPending}
          />
        </>
      )}
    </div>
  );
}
