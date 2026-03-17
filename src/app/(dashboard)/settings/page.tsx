"use client";

import { useState } from "react";
import { useSession } from "@/lib/auth-client";
import {
  useActiveOrganization,
  useInviteMember,
  useRemoveMember,
} from "@/hooks/use-organization";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { toast } from "sonner";
import { Copy } from "lucide-react";

export default function SettingsPage() {
  const { data: session } = useSession();
  const orgQuery = useActiveOrganization();
  const inviteMutation = useInviteMember();
  const removeMutation = useRemoveMember();

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");

  const org = orgQuery.data;

  function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!org) return;

    inviteMutation.mutate(
      {
        email: inviteEmail,
        role: inviteRole as "member" | "admin",
        organizationId: org.id,
      },
      {
        onSuccess: () => {
          toast.success(`Invitation sent to ${inviteEmail}`);
          setInviteEmail("");
        },
        onError: (error) => {
          toast.error(error.message || "Failed to send invitation");
        },
      },
    );
  }

  function handleRemoveMember(memberId: string) {
    removeMutation.mutate(
      { memberIdOrEmail: memberId },
      {
        onSuccess: () => toast.success("Member removed"),
        onError: (error) =>
          toast.error(error.message || "Failed to remove member"),
      },
    );
  }

  if (orgQuery.isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  if (!org) {
    return (
      <div className="text-sm text-muted-foreground">
        No active workspace found.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-lg font-medium tracking-tight">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid gap-1">
            <span className="text-[13px] text-muted-foreground">Name</span>
            <span className="text-sm font-medium">{org.name}</span>
          </div>
          <div className="grid gap-1">
            <span className="text-[13px] text-muted-foreground">Slug</span>
            <span className="font-mono text-sm">{org.slug}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Members</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {org.members.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
              >
                <div className="grid gap-0.5">
                  <span className="text-sm font-medium">{m.user.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {m.user.email}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={m.role === "owner" ? "default" : "secondary"}
                    className="text-[11px]"
                  >
                    {m.role}
                  </Badge>
                  {m.role !== "owner" &&
                    m.user.id !== session?.user.id && (
                      <ConfirmDialog
                        title="Remove member"
                        description={`Remove ${m.user.name} from this workspace?`}
                        confirmLabel="Remove"
                        onConfirm={() => handleRemoveMember(m.id)}
                        loading={removeMutation.isPending}
                        trigger={
                          <Button variant="ghost" size="sm" className="text-muted-foreground">
                            Remove
                          </Button>
                        }
                      />
                    )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invite member</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleInvite} className="flex items-end gap-3">
            <div className="grid flex-1 gap-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="colleague@example.com"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>Role</Label>
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={inviteMutation.isPending}>
              {inviteMutation.isPending ? "Sending..." : "Invite"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {org.invitations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending invitations</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {org.invitations.map((inv) => {
                const inviteLink = `${window.location.origin}/invite/${inv.id}`;
                return (
                  <div
                    key={inv.id}
                    className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="grid gap-0.5 min-w-0 flex-1">
                      <span className="text-sm font-medium">{inv.email}</span>
                      <span className="text-xs text-muted-foreground/50 truncate font-mono">
                        {inviteLink}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground"
                        onClick={() => {
                          navigator.clipboard.writeText(inviteLink);
                          toast.success("Invite link copied");
                        }}
                      >
                        <Copy className="size-3.5" />
                      </Button>
                      <Badge variant="outline" className="text-[11px]">
                        {inv.status}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
