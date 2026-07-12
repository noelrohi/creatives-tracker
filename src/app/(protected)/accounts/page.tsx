"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { useTRPC } from "@/lib/trpc/client";
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
import {
  Ban,
  CheckCircle2,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "@/components/icons";
import { toast } from "sonner";

interface AccountForm {
  name: string;
  metaAccountId: string;
  metaAccessToken: string;
  defaultFacebookPageId: string;
  defaultInstagramActorId: string;
  notes: string;
}

type AccountRow = {
  id: string;
  name: string;
  metaAccountId: string;
  defaultFacebookPageId: string | null;
  defaultInstagramActorId: string | null;
  notes: string | null;
  isDisabled: boolean;
  hasMetaAccessToken: boolean;
};

export default function AccountsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const accounts = useQuery(
    trpc.adAccount.list.queryOptions({ includeDisabled: true }),
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const form = useForm<AccountForm>({
    defaultValues: {
      name: "",
      metaAccountId: "",
      metaAccessToken: "",
      defaultFacebookPageId: "",
      defaultInstagramActorId: "",
      notes: "",
    },
  });

  const createMutation = useMutation(
    trpc.adAccount.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.adAccount.list.queryKey() });
        toast.success("Account added");
        closeDialog();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const updateMutation = useMutation(
    trpc.adAccount.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.adAccount.list.queryKey() });
        toast.success("Account updated");
        closeDialog();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const toggleDisabledMutation = useMutation(
    trpc.adAccount.update.mutationOptions({
      onSuccess: (account) => {
        queryClient.invalidateQueries({ queryKey: trpc.adAccount.list.queryKey() });
        toast.success(account.isDisabled ? "Account disabled" : "Account enabled");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const deleteMutation = useMutation(
    trpc.adAccount.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.adAccount.list.queryKey() });
        toast.success("Account deleted");
        setDeleteId(null);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  function openCreate() {
    setEditingId(null);
    form.reset({
      name: "",
      metaAccountId: "",
      metaAccessToken: "",
      defaultFacebookPageId: "",
      defaultInstagramActorId: "",
      notes: "",
    });
    setDialogOpen(true);
  }

  function openEdit(account: AccountRow) {
    setEditingId(account.id);
    form.reset({
      name: account.name,
      metaAccountId: account.metaAccountId,
      metaAccessToken: "",
      defaultFacebookPageId: account.defaultFacebookPageId ?? "",
      defaultInstagramActorId: account.defaultInstagramActorId ?? "",
      notes: account.notes ?? "",
    });
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingId(null);
  }

  function onSubmit(values: AccountForm) {
    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        name: values.name,
        metaAccountId: values.metaAccountId,
        defaultFacebookPageId: values.defaultFacebookPageId || null,
        defaultInstagramActorId: values.defaultInstagramActorId || null,
        notes: values.notes || null,
        ...(values.metaAccessToken
          ? { metaAccessToken: values.metaAccessToken }
          : {}),
      });
    } else {
      createMutation.mutate({
        name: values.name,
        metaAccountId: values.metaAccountId,
        metaAccessToken: values.metaAccessToken || undefined,
        defaultFacebookPageId: values.defaultFacebookPageId || undefined,
        defaultInstagramActorId: values.defaultInstagramActorId || undefined,
        notes: values.notes || undefined,
      });
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Accounts</h1>
          <p className="text-sm text-muted-foreground">
            Manage your Meta ad accounts.
          </p>
        </div>
        <Button size="sm" onClick={openCreate} className="gap-1.5">
          <Plus className="size-3.5" /> Add Account
        </Button>
      </div>

      {accounts.isLoading ? (
        <div className="rounded-lg border divide-y">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
              <div className="flex-1" />
              <Skeleton className="size-8" />
            </div>
          ))}
        </div>
      ) : accounts.data?.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-16">
          <div className="text-center">
            <p className="text-sm text-muted-foreground">No accounts yet</p>
            <p className="text-[13px] text-muted-foreground/40">
              Add a Meta ad account to link your ads.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={openCreate} className="gap-1.5">
            <Plus className="size-3.5" /> Add Account
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Meta Account ID</TableHead>
                <TableHead>Publishing identity</TableHead>
                <TableHead>Access Token</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.data?.map((account) => (
                <TableRow key={account.id} className={account.isDisabled ? "opacity-60" : undefined}>
                  <TableCell className="font-medium">{account.name}</TableCell>
                  <TableCell>
                    <span className={account.isDisabled ? "text-[13px] text-muted-foreground" : "text-[13px] text-foreground"}>
                      {account.isDisabled ? "Disabled" : "Active"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <code className="text-[13px] text-muted-foreground">
                        {account.metaAccountId}
                      </code>
                      <a
                        href={`https://www.facebook.com/adsmanager/manage/campaigns?act=${account.metaAccountId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground/50 hover:text-foreground transition-colors"
                        title="Open in Meta Ads Manager"
                      >
                        <ExternalLink className="size-3" />
                      </a>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1 text-[13px]">
                      {account.defaultFacebookPageId ? (
                        <div>
                          <span className="text-muted-foreground">Page </span>
                          <code>{account.defaultFacebookPageId}</code>
                        </div>
                      ) : (
                        <div className="text-muted-foreground/50">No Page ID</div>
                      )}
                      {account.defaultInstagramActorId ? (
                        <div>
                          <span className="text-muted-foreground">IG </span>
                          <code>{account.defaultInstagramActorId}</code>
                        </div>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    {account.hasMetaAccessToken ? (
                      <span className="text-[13px] text-muted-foreground">
                        Stored
                      </span>
                    ) : (
                      <span className="text-muted-foreground/30">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm">
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(account)}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={toggleDisabledMutation.isPending}
                          onClick={() =>
                            toggleDisabledMutation.mutate({
                              id: account.id,
                              isDisabled: !account.isDisabled,
                            })
                          }
                        >
                          {account.isDisabled ? <CheckCircle2 /> : <Ban />}
                          {account.isDisabled ? "Enable" : "Disable"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeleteId(account.id)}
                        >
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); else setDialogOpen(true); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Account" : "Add Account"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input {...form.register("name", { required: true })} placeholder="e.g., Reviv Main" />
            </Field>
            <Field>
              <FieldLabel>Meta Account ID</FieldLabel>
              <Input {...form.register("metaAccountId", { required: true })} placeholder="e.g., 123456789" />
            </Field>
            <Field>
              <FieldLabel>Access Token {editingId ? "(leave blank to keep current)" : "(optional)"}</FieldLabel>
              <Input {...form.register("metaAccessToken")} placeholder="Meta API access token" type="password" />
            </Field>
            <Field>
              <FieldLabel>Default Facebook Page ID</FieldLabel>
              <Input {...form.register("defaultFacebookPageId")} placeholder="e.g., 1234567890" />
            </Field>
            <Field>
              <FieldLabel>Default Instagram actor ID (optional)</FieldLabel>
              <Input {...form.register("defaultInstagramActorId")} placeholder="e.g., 17841400000000000" />
            </Field>
            <Field>
              <FieldLabel>Notes (optional)</FieldLabel>
              <Input {...form.register("notes")} placeholder="Any notes..." />
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={closeDialog}>Cancel</Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? "Saving..." : editingId ? "Save" : "Add"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => { if (!open) setDeleteId(null); }}
        title="Delete account"
        description="This will remove the account. Ads linked to it will keep their data."
        confirmLabel="Delete"
        onConfirm={() => deleteId && deleteMutation.mutate({ id: deleteId })}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
