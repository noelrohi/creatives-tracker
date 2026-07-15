"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  CalendarIcon,
  Copy,
  Check,
  Key,
  Loader2,
  Plus,
  ShieldAlert,
  Trash2,
  Ban,
  AlertTriangle,
} from "@/components/icons";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

const createKeySchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
});

type CreateKeyValues = z.infer<typeof createKeySchema>;

type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  createdByUserId: string;
};

function getStatus(row: ApiKeyRow): "Active" | "Revoked" | "Expired" {
  if (row.revokedAt) return "Revoked";
  if (row.expiresAt && new Date(row.expiresAt) < new Date()) return "Expired";
  return "Active";
}

function statusVariant(status: string) {
  if (status === "Active") return "default" as const;
  if (status === "Revoked") return "destructive" as const;
  return "secondary" as const;
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return "\u2014";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function ApiKeysPage() {
  const { data: activeOrg } = authClient.useActiveOrganization();
  const { data: session } = authClient.useSession();
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  const orgId = activeOrg?.id;

  // Determine role
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

  const members = fullOrg?.members ?? [];
  const currentUserRole = members.find(
    (m: { userId: string }) => m.userId === session?.user?.id,
  )?.role;
  const isAdmin = currentUserRole === "owner" || currentUserRole === "admin";

  // List keys
  const listQuery = useQuery(trpc.apiKey.list.queryOptions());

  // Create key
  const createMutation = useMutation(
    trpc.apiKey.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.apiKey.list.queryKey() });
      },
    }),
  );

  // Revoke key
  const revokeMutation = useMutation(
    trpc.apiKey.revoke.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.apiKey.list.queryKey() });
        toast.success("API key revoked");
      },
    }),
  );

  // Delete key
  const deleteMutation = useMutation(
    trpc.apiKey.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.apiKey.list.queryKey() });
        setDeleteTarget(null);
        toast.success("API key deleted");
      },
    }),
  );

  // Reveal dialog state
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Delete confirm state
  const [deleteTarget, setDeleteTarget] = useState<ApiKeyRow | null>(null);

  // Expiration date picker state
  const [expiresAt, setExpiresAt] = useState<Date | undefined>(undefined);

  // Access level for the new key
  const [scopeChoice, setScopeChoice] = useState<"*" | "read">("*");

  const form = useForm<CreateKeyValues>({
    resolver: zodResolver(createKeySchema),
    defaultValues: { name: "" },
  });

  async function onSubmit(data: CreateKeyValues) {
    const result = await createMutation.mutateAsync({
      name: data.name,
      scopes: scopeChoice === "read" ? ["read"] : ["*"],
      expiresAt: expiresAt ? expiresAt.toISOString() : undefined,
    });

    setRevealedKey(result.key);
    setExpiresAt(undefined);
    setScopeChoice("*");
    form.reset();
  }

  function handleCopy() {
    if (!revealedKey) return;
    navigator.clipboard.writeText(revealedKey);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  }

  const keys: ApiKeyRow[] = (listQuery.data as ApiKeyRow[] | undefined) ?? [];

  // Non-admin state
  if (fullOrg && !isAdmin) {
    return (
      <div className="mx-auto max-w-2xl space-y-10">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">API Keys</h1>
          <p className="text-sm text-muted-foreground">
            Organization-scoped API access for automation and integrations.
          </p>
        </div>
        <div className="flex flex-col items-center gap-3 rounded-lg border p-10 text-center">
          <ShieldAlert className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">Admins only</p>
          <p className="text-sm text-muted-foreground">
            Only organization owners and admins can manage API keys.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-10">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold tracking-tight">API Keys</h1>
        <p className="text-sm text-muted-foreground">
          Organization-scoped API access for automation and integrations.
          Use keys as{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            Authorization: Bearer &lt;key&gt;
          </code>
        </p>
      </div>

      {/* Create key form */}
      {isAdmin && (
        <div className="rounded-lg border p-5">
          <div className="mb-4 flex items-center gap-2">
            <Plus className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Create a new key</h2>
          </div>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-4 sm:flex-row">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="key-name">Name</Label>
                <Input
                  {...form.register("name")}
                  id="key-name"
                  placeholder="e.g. CI Pipeline"
                />
                {form.formState.errors.name && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.name.message}
                  </p>
                )}
              </div>
              <div className="w-full space-y-1.5 sm:w-48">
                <Label htmlFor="key-scopes">Access</Label>
                <Select
                  value={scopeChoice}
                  onValueChange={(value) =>
                    setScopeChoice(value === "read" ? "read" : "*")
                  }
                >
                  <SelectTrigger id="key-scopes" className="w-full">
                    <SelectValue placeholder="Read + write" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="*">Read + write</SelectItem>
                    <SelectItem value="read">Read only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="w-full space-y-1.5 sm:w-48">
                <Label>Expires</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !expiresAt && "text-muted-foreground",
                      )}
                    >
                      <CalendarIcon className="mr-2 size-4" />
                      {expiresAt ? format(expiresAt, "MMM d, yyyy") : "No expiration"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={expiresAt}
                      onSelect={setExpiresAt}
                      disabled={(date) => date < new Date()}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
            <div>
              <Button
                type="submit"
                disabled={createMutation.isPending}
                className="shrink-0"
              >
                {createMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Key className="size-4" />
                )}
                Create key
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Keys table */}
      <div>
        <h2 className="mb-3 text-sm font-medium">
          Existing keys{!listQuery.isLoading && ` (${keys.length})`}
        </h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Status</TableHead>
                {isAdmin && <TableHead className="w-[100px]">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {listQuery.isLoading && (
                <>
                  {[1, 2].map((i) => (
                    <TableRow key={i}>
                      {Array.from({ length: isAdmin ? 8 : 7 }).map((_, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-16" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </>
              )}
              {!listQuery.isLoading && keys.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={isAdmin ? 8 : 7}
                    className="text-center text-sm text-muted-foreground py-8"
                  >
                    No API keys yet. Create one above to get started.
                  </TableCell>
                </TableRow>
              )}
              {!listQuery.isLoading &&
                keys.map((row) => {
                  const status = getStatus(row);
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium text-sm">
                        {row.name}
                      </TableCell>
                      <TableCell>
                        <code className="text-xs">{row.prefix}...</code>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">
                          {row.scopes.join(", ")}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatDate(row.createdAt)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatDate(row.expiresAt)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatDate(row.lastUsedAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(status)}>{status}</Badge>
                      </TableCell>
                      {isAdmin && (
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {status === "Active" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                disabled={revokeMutation.isPending}
                                onClick={() =>
                                  revokeMutation.mutate({ id: row.id })
                                }
                                title="Revoke"
                              >
                                <Ban className="size-3.5" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-destructive hover:text-destructive"
                              onClick={() => setDeleteTarget(row)}
                              title="Delete"
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Reveal key dialog */}
      <Dialog
        open={!!revealedKey}
        onOpenChange={(open) => {
          if (!open) {
            setRevealedKey(null);
            setCopied(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Key className="size-4" />
              API Key Created
            </DialogTitle>
            <DialogDescription>
              Copy your key now. It will not be shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md border bg-muted px-3 py-2 text-sm break-all select-all">
                {revealedKey}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={handleCopy}
                className="shrink-0"
              >
                {copied ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
              </Button>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>
                This is the only time you will see this key. Store it securely.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete API key</DialogTitle>
            <DialogDescription>
              This will permanently delete{" "}
              <span className="font-medium text-foreground">
                {deleteTarget?.name}
              </span>
              . This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate({ id: deleteTarget.id });
              }}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                "Delete"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
