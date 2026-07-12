"use client";

import { useState, type ComponentType } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isPrivilegedOrgRole } from "@/lib/organization-access";
import { authClient } from "@/lib/auth-client";
import { getUserFacingErrorMessage } from "@/lib/errors";
import { createOrganizationWithUniqueSlug } from "@/lib/organization-client";
import { toast } from "sonner";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  BookOpen,
  Building2,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  Key,
  LayoutDashboard,
  LogOut,
  Upload,
  Image,
  Settings,
  TrendingUp,
  Users,
  Pencil,
  Plus,
  Sparkles,
  UserPlus,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DeleteOrganizationDialog } from "@/components/delete-organization-dialog";
import { isImageStudioEnabled } from "@/lib/image-studio-enabled";

const dashboardSubItems = [
  { label: "Overview", href: "/", icon: LayoutDashboard },
  { label: "MER", href: "/mer", icon: TrendingUp },
];

const navItems: Array<{
  label: string;
  href: string;
  icon: ComponentType;
  badge?: string;
}> = [
  { label: "Creatives", href: "/creatives", icon: Image },
  { label: "Teams", href: "/teams", icon: Users },
  { label: "Accounts", href: "/accounts", icon: Settings },
];

const toolItems: Array<{
  label: string;
  href: string;
  icon: ComponentType;
  badge?: string;
}> = isImageStudioEnabled()
  ? [{ label: "Image Studio", href: "/studio", icon: Sparkles, badge: "Beta" }]
  : [];

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session, refetch: refetchSession } = authClient.useSession();
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const [showNewOrg, setShowNewOrg] = useState(false);
  const [showRenameOrg, setShowRenameOrg] = useState(false);
  const [showDeleteOrg, setShowDeleteOrg] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [renameOrgName, setRenameOrgName] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
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
    (orgMember: { userId: string; role: string }) =>
      orgMember.userId === session?.user?.id,
  )?.role;
  const isOwner = currentUserRole === "owner";
  const isPrivileged = isPrivilegedOrgRole(
    currentUserRole === "owner" || currentUserRole === "admin"
      ? currentUserRole
      : null,
  );
  const visibleNavItems = isPrivileged
    ? navItems
    : navItems.filter((item) => item.href !== "/accounts");

  async function handleSignOut() {
    await authClient.signOut();
    queryClient.clear();
    router.push("/sign-in");
    router.refresh();
  }

  async function switchOrg(orgId: string) {
    if (orgId === activeOrg?.id) {
      return;
    }

    const { error } = await authClient.organization.setActive({
      organizationId: orgId,
    });

    if (error) {
      toast.error(
        getUserFacingErrorMessage(error, "Failed to switch workspace."),
      );
      return;
    }

    await refetchSession();
    queryClient.clear();
    router.refresh();
  }

  async function handleCreateOrg(e: React.FormEvent) {
    e.preventDefault();
    if (!newOrgName.trim()) return;
    setCreating(true);

    let data;

    try {
      data = await createOrganizationWithUniqueSlug(newOrgName);
    } catch (error) {
      toast.error(
        getUserFacingErrorMessage(error, "Failed to create workspace."),
      );
      setCreating(false);
      return;
    }

    if (data) {
      await authClient.organization.setActive({ organizationId: data.id });
    }

    setNewOrgName("");
    setShowNewOrg(false);
    setCreating(false);
    await refetchSession();
    queryClient.clear();
    router.refresh();
  }

  function openRenameDialog() {
    setRenameOrgName(activeOrg?.name ?? "");
    setShowRenameOrg(true);
  }

  async function handleRenameOrg(e: React.FormEvent) {
    e.preventDefault();
    if (!renameOrgName.trim() || !activeOrg) return;
    setRenaming(true);

    const { error } = await authClient.organization.update({
      data: { name: renameOrgName.trim() },
    });

    if (error) {
      toast.error(
        getUserFacingErrorMessage(error, "Failed to rename workspace."),
      );
      setRenaming(false);
      return;
    }

    setShowRenameOrg(false);
    setRenaming(false);
    await refetchSession();
    queryClient.invalidateQueries({ queryKey: ["org-full", orgId] });
    router.refresh();
  }

  return (
    <>
      <Sidebar variant="inset">
        <SidebarHeader>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
                  {activeOrg?.name?.[0]?.toUpperCase() ?? "A"}
                </div>
                <div className="flex flex-1 flex-col truncate">
                  <span className="truncate text-sm font-semibold">
                    {activeOrg?.name ?? "Adsolute"}
                  </span>
                </div>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {orgs?.map((org) => (
                <DropdownMenuItem
                  key={org.id}
                  onClick={() => switchOrg(org.id)}
                >
                  <Building2 className="mr-2 size-4" />
                  <span className="truncate">{org.name}</span>
                  {org.id === activeOrg?.id && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      Active
                    </span>
                  )}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setShowNewOrg(true)}>
                <Plus className="mr-2 size-4" />
                Create organization
              </DropdownMenuItem>
              {activeOrg && isPrivileged ? (
                <DropdownMenuItem onSelect={openRenameDialog}>
                  <Pencil className="mr-2 size-4" />
                  Rename workspace
                </DropdownMenuItem>
              ) : null}
              {activeOrg && isOwner ? (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setShowDeleteOrg(true)}
                >
                  <Trash2 className="mr-2 size-4" />
                  Delete workspace
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent className="flex flex-col gap-2">
              <SidebarMenu>
                <SidebarMenuItem className="flex items-center gap-2">
                  {isPrivileged ? (
                    <>
                      <SidebarMenuButton
                        asChild
                        tooltip="Import"
                        className="min-w-8 bg-primary text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
                      >
                        <Link href="/import">
                          <CirclePlus />
                          <span>Import</span>
                        </Link>
                      </SidebarMenuButton>
                      <Button
                        size="icon"
                        className="size-8 group-data-[collapsible=icon]:opacity-0"
                        variant="outline"
                        asChild
                      >
                        <Link href="/import">
                          <Upload />
                          <span className="sr-only">Import</span>
                        </Link>
                      </Button>
                    </>
                  ) : null}
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <Collapsible
                  defaultOpen
                  className="group/collapsible"
                >
                  <SidebarMenuItem>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuButton
                        tooltip="Dashboard"
                        isActive={
                          pathname === "/" || pathname.startsWith("/mer")
                        }
                      >
                        <LayoutDashboard />
                        <span>Dashboard</span>
                        <ChevronRight className="ml-auto size-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                      </SidebarMenuButton>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        {dashboardSubItems.map((sub) => {
                          const isActive =
                            sub.href === "/"
                              ? pathname === "/"
                              : pathname === sub.href || pathname.startsWith(`${sub.href}/`);
                          return (
                            <SidebarMenuSubItem key={sub.href}>
                              <SidebarMenuSubButton asChild isActive={isActive}>
                                <Link href={sub.href}>
                                  <sub.icon />
                                  <span>{sub.label}</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          );
                        })}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
                {visibleNavItems.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      tooltip={item.label}
                      isActive={pathname.startsWith(item.href)}
                      className={item.badge ? "pr-14" : undefined}
                    >
                      <Link href={item.href}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {item.badge ? (
                      <SidebarMenuBadge className="rounded-full border border-sidebar-border bg-sidebar-accent/80 px-2 text-[10px] font-semibold uppercase tracking-wide text-sidebar-accent-foreground">
                        {item.badge}
                      </SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Tools</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {toolItems.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      tooltip={item.label}
                      isActive={pathname.startsWith(item.href)}
                      className={item.badge ? "pr-14" : undefined}
                    >
                      <Link href={item.href}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {item.badge ? (
                      <SidebarMenuBadge className="rounded-full border border-sidebar-border bg-sidebar-accent/80 px-2 text-[10px] font-semibold uppercase tracking-wide text-sidebar-accent-foreground">
                        {item.badge}
                      </SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            {isPrivileged ? (
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="API Docs">
                  <Link href="/reference">
                    <BookOpen />
                    <span>API Docs</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton tooltip={session?.user?.name ?? "User"}>
                    <div className="flex size-5 items-center justify-center rounded-full bg-muted text-xs font-medium">
                      {session?.user?.name?.[0]?.toUpperCase() ?? "?"}
                    </div>
                    <span className="truncate">
                      {session?.user?.name ?? "User"}
                    </span>
                    <ChevronDown className="ml-auto size-4" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuItem disabled>
                    <span className="truncate text-xs text-muted-foreground">
                      {session?.user?.email}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {isPrivileged ? (
                    <>
                      <DropdownMenuItem asChild>
                        <Link href="/settings/org">
                          <Building2 className="mr-2 size-4" />
                          Organization
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/settings/members">
                          <UserPlus className="mr-2 size-4" />
                          Invite members
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/settings/api-keys">
                          <Key className="mr-2 size-4" />
                          API keys
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  <DropdownMenuItem onClick={handleSignOut}>
                    <LogOut className="mr-2 size-4" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <Dialog open={showNewOrg} onOpenChange={setShowNewOrg}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create organization</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateOrg} className="flex flex-col gap-4">
            <div className="space-y-2">
              <Label htmlFor="new-org-name">Name</Label>
              <Input
                id="new-org-name"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                placeholder="My Company"
                required
                autoFocus
              />
            </div>
            <Button type="submit" disabled={creating} className="w-full">
              {creating ? "Creating..." : "Create"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showRenameOrg} onOpenChange={setShowRenameOrg}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleRenameOrg} className="flex flex-col gap-4">
            <div className="space-y-2">
              <Label htmlFor="rename-org-name">Name</Label>
              <Input
                id="rename-org-name"
                value={renameOrgName}
                onChange={(e) => setRenameOrgName(e.target.value)}
                placeholder="My Company"
                required
                autoFocus
              />
            </div>
            <Button type="submit" disabled={renaming || !renameOrgName.trim()} className="w-full">
              {renaming ? "Renaming..." : "Rename"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <DeleteOrganizationDialog
        open={showDeleteOrg}
        onOpenChange={setShowDeleteOrg}
        organization={
          activeOrg
            ? {
                id: activeOrg.id,
                name: activeOrg.name,
              }
            : null
        }
      />
    </>
  );
}
