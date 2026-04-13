"use client";

import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Copy, Loader2, Mail, MoreHorizontal, UserPlus } from "lucide-react";
import { toast } from "sonner";

const inviteSchema = z.object({
  email: z.string().email("Enter a valid email address."),
  role: z.enum(["member", "admin"]),
});

type InviteValues = z.infer<typeof inviteSchema>;

export default function MembersPage() {
  const { data: activeOrg } = authClient.useActiveOrganization();
  const { data: session } = authClient.useSession();
  const queryClient = useQueryClient();

  const orgId = activeOrg?.id;

  const { data: fullOrg, isLoading } = useQuery({
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
  const invitations = (fullOrg?.invitations ?? []).filter(
    (i: { status: string }) => i.status === "pending",
  );

  const form = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "", role: "member" },
  });

  async function onSubmit(data: InviteValues) {
    if (!orgId) return;

    const { error } = await authClient.organization.inviteMember({
      email: data.email,
      role: data.role,
      organizationId: orgId,
    });

    if (error) {
      toast.error(error.message ?? "Failed to send invitation");
      return;
    }

    toast.success(`Invitation sent to ${data.email}`);
    form.reset();
    queryClient.invalidateQueries({ queryKey: ["org-full", orgId] });
  }

  async function copyInvitationLink(invitationId: string) {
    try {
      const invitationUrl = new URL(
        `/accept-invitation?invitationId=${encodeURIComponent(invitationId)}`,
        window.location.origin,
      ).toString();

      await navigator.clipboard.writeText(invitationUrl);
      toast.success("Invitation link copied");
    } catch {
      toast.error("Failed to copy invitation link");
    }
  }

  const currentUserRole = members.find(
    (m: { userId: string }) => m.userId === session?.user?.id,
  )?.role;
  const canInvite = currentUserRole === "owner" || currentUserRole === "admin";

  return (
    <div className="mx-auto max-w-2xl space-y-10">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Members</h1>
        <p className="text-sm text-muted-foreground">
          Manage who has access to{" "}
          <span className="font-medium text-foreground">
            {activeOrg?.name ?? "your organization"}
          </span>
          .
        </p>
      </div>

      {/* Invite form */}
      {canInvite && (
        <div className="rounded-lg border p-5">
          <div className="mb-4 flex items-center gap-2">
            <UserPlus className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Invite a member</h2>
          </div>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4 sm:flex-row sm:items-end"
          >
            <div className="flex-1">
              <Controller
                name="email"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor={field.name} className="sr-only">
                      Email
                    </FieldLabel>
                    <Input
                      {...field}
                      id={field.name}
                      type="email"
                      placeholder="colleague@example.com"
                      aria-invalid={fieldState.invalid}
                      autoComplete="email"
                    />
                    {fieldState.invalid && (
                      <FieldError errors={[fieldState.error]} />
                    )}
                  </Field>
                )}
              />
            </div>

            <Controller
              name="role"
              control={form.control}
              render={({ field }) => (
                <Select
                  name={field.name}
                  value={field.value}
                  onValueChange={field.onChange}
                >
                  <SelectTrigger className="w-[120px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />

            <Button
              type="submit"
              disabled={form.formState.isSubmitting}
              className="shrink-0"
            >
              {form.formState.isSubmitting ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Mail className="size-4" />
              )}
              Send invite
            </Button>
          </form>
        </div>
      )}

      {/* Members list */}
      <div>
        <h2 className="mb-3 text-sm font-medium">
          Active members{!isLoading && ` (${members.length})`}
        </h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead className="w-[100px]">Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <>
                  {[1, 2].map((i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <div className="space-y-1.5">
                          <Skeleton className="h-4 w-28" />
                          <Skeleton className="h-3 w-40" />
                        </div>
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-5 w-16" />
                      </TableCell>
                    </TableRow>
                  ))}
                </>
              )}
              {!isLoading &&
                members.map(
                  (member: {
                    id: string;
                    userId: string;
                    role: string;
                    user: { name: string; email: string };
                  }) => (
                    <TableRow key={member.id}>
                      <TableCell>
                        <div>
                          <p className="text-sm font-medium">
                            {member.user.name}
                            {member.userId === session?.user?.id && (
                              <span className="ml-1.5 text-xs text-muted-foreground">
                                (you)
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {member.user.email}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">
                          {member.role}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ),
                )}
              {!isLoading && members.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={2}
                    className="text-center text-sm text-muted-foreground"
                  >
                    No members found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Pending invitations */}
      {invitations.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-medium">
            Pending invitations ({invitations.length})
          </h2>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead className="w-[100px]">Role</TableHead>
                  <TableHead className="w-[100px]">Status</TableHead>
                  {canInvite ? (
                    <TableHead className="w-[56px] text-right">Actions</TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.map(
                  (inv: {
                    id: string;
                    email: string;
                    role: string | null;
                    status: string;
                  }) => (
                    <TableRow key={inv.id}>
                      <TableCell className="text-sm">{inv.email}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">
                          {inv.role ?? "member"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="capitalize">
                          {inv.status}
                        </Badge>
                      </TableCell>
                      {canInvite ? (
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                aria-label={`Open actions for ${inv.email}`}
                              >
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => copyInvitationLink(inv.id)}
                              >
                                <Copy className="size-4" />
                                Copy invitation link
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
