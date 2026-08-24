"use client";

import { useState } from "react";
import { Icon } from "@iconify/react";
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
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarTrigger,
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DeleteOrganizationDialog } from "@/components/delete-organization-dialog";
import { AdsoluteMark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { useTRPC } from "@/lib/trpc/client";
import { featureFlagDefs } from "@/lib/feature-flags";

const dashboardSubItems: Array<{
  label: string;
  href: string;
  icon: string;
  badge?: string;
}> = [
  { label: "MER", href: "/mer", icon: "solar:graph-up-linear" },
];

/**
 * The Dashboard entry's dropdown: one row per source with its own screen.
 * The labs are privileged navigation only — hiding them is UX, the
 * `orgAdminProcedure` on their data remains the security boundary.
 */
const dashboardChildren: Array<{
  label: string;
  href: string;
  icon: string;
  privileged?: boolean;
}> = [
  { label: "Meta", href: "/meta", icon: "solar:cursor-square-linear" },
  {
    label: "Klaviyo",
    href: "/attribution/klaviyo",
    icon: "solar:letter-linear",
    privileged: true,
  },
  {
    label: "Google",
    href: "/attribution/google-ads",
    icon: "solar:magnifer-linear",
    privileged: true,
  },
];

const navItems: Array<{
  label: string;
  href: string;
  icon: string;
  badge?: string;
  privileged?: boolean;
}> = [
  { label: "Creatives", href: "/creatives", icon: "solar:gallery-linear" },
  { label: "Campaigns", href: "/campaigns", icon: "solar:layers-minimalistic-linear" },
  { label: "Imports", href: "/import", icon: "solar:upload-linear", privileged: true },
  { label: "Teams", href: "/teams", icon: "solar:users-group-rounded-linear" },
  { label: "Accounts", href: "/accounts", icon: "solar:settings-linear", privileged: true },
];

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
  const trpc = useTRPC();

  /**
   * Controlled, not `defaultOpen`: Radix only reads `defaultOpen` at mount, so
   * a client-side navigation onto `/meta` or a lab would leave the active
   * child hidden behind a closed dropdown. The open state is derived from the
   * route; a manual toggle wins only while the pathname it happened on is
   * still current, so every navigation re-follows the route.
   */
  const dashboardRouteActive =
    pathname === "/" ||
    dashboardChildren.some(
      (child) =>
        pathname === child.href || pathname.startsWith(`${child.href}/`),
    );
  const [dashboardToggle, setDashboardToggle] = useState<{
    pathname: string;
    open: boolean;
  } | null>(null);
  const dashboardOpen =
    dashboardToggle?.pathname === pathname
      ? dashboardToggle.open
      : dashboardRouteActive;
  const setDashboardOpen = (open: boolean) =>
    setDashboardToggle({ pathname, open });

  /** Where the money is read rather than managed: gated behind org feature flags. */
  const { data: featureFlags } = useQuery(
    trpc.orgSettings.getFeatureFlags.queryOptions(),
  );
  const enabledFlagDefs = featureFlagDefs.filter(
    (def) => featureFlags?.[def.key] ?? false,
  );
  const analyzeItems = enabledFlagDefs.filter((def) => def.group === "analyze");
  const toolsItems = enabledFlagDefs.filter((def) => def.group === "tools");

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
    : navItems.filter((item) => !item.privileged);

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
          <div className="group/header-row flex h-8 items-center gap-2 px-2">
            <Link href="/" className="flex min-w-0 flex-1 items-center gap-2 group-data-[collapsible=icon]:hidden">
              <div className="flex size-7 shrink-0 items-center justify-center">
                <AdsoluteMark size={20} adaptive />
              </div>
              <span className="truncate text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
                Adsolute
              </span>
            </Link>
            <SidebarTrigger className="shrink-0 opacity-0 transition-opacity group-hover/header-row:opacity-100 focus-visible:opacity-100" />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex w-full items-center gap-1.5 rounded-md border border-sidebar-border bg-sidebar px-1.5 py-1 text-left shadow-xs transition-colors hover:bg-sidebar-accent">
                <div className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-primary text-xs font-semibold text-primary-foreground">
                  {activeOrg?.name?.[0]?.toUpperCase() ?? "A"}
                </div>
                <div className="flex flex-1 flex-col truncate">
                  <span className="truncate text-sm font-semibold">
                    {activeOrg?.name ?? "Adsolute"}
                  </span>
                </div>
                <Icon icon="solar:alt-arrow-down-linear" className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {orgs?.map((org) => (
                <DropdownMenuItem
                  key={org.id}
                  onClick={() => switchOrg(org.id)}
                >
                  <Icon icon="solar:buildings-2-linear" className="mr-2 size-4" />
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
                <Icon icon="solar:add-circle-linear" className="mr-2 size-4" />
                Create organization
              </DropdownMenuItem>
              {activeOrg && isPrivileged ? (
                <DropdownMenuItem onSelect={openRenameDialog}>
                  <Icon icon="solar:pen-linear" className="mr-2 size-4" />
                  Rename workspace
                </DropdownMenuItem>
              ) : null}
              {activeOrg && isOwner ? (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setShowDeleteOrg(true)}
                >
                  <Icon icon="solar:trash-bin-trash-linear" className="mr-2 size-4" />
                  Delete workspace
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <Collapsible
                  asChild
                  open={dashboardOpen}
                  onOpenChange={setDashboardOpen}
                  className="group/collapsible"
                >
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      tooltip="Dashboard"
                      isActive={pathname === "/"}
                    >
                      <Link href="/">
                        <Icon icon="solar:widget-5-linear" className="size-4" />
                        <span>Dashboard</span>
                      </Link>
                    </SidebarMenuButton>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuAction className="transition-transform group-data-[state=open]/collapsible:rotate-90">
                        <Icon icon="solar:alt-arrow-right-linear" />
                        <span className="sr-only">Toggle sources</span>
                      </SidebarMenuAction>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        {dashboardChildren
                          .filter((child) => isPrivileged || !child.privileged)
                          .map((child) => (
                            <SidebarMenuSubItem key={child.href}>
                              <SidebarMenuSubButton
                                asChild
                                isActive={
                                  pathname === child.href ||
                                  pathname.startsWith(`${child.href}/`)
                                }
                              >
                                <Link href={child.href}>
                                  <Icon
                                    icon={child.icon}
                                    className="size-4"
                                  />
                                  <span>{child.label}</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
                {dashboardSubItems.map((item) => {
                  const isActive =
                    item.href === "/"
                      ? pathname === "/"
                      : pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        tooltip={item.label}
                        isActive={isActive}
                        className={item.badge ? "pr-14" : undefined}
                      >
                        <Link href={item.href}>
                          <Icon icon={item.icon} className="size-4" />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                      {item.badge ? (
                        <SidebarMenuBadge className="rounded-full border border-sidebar-border bg-sidebar-accent/80 px-2 text-[10px] font-semibold uppercase tracking-wide text-sidebar-accent-foreground">
                          {item.badge}
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {analyzeItems.length > 0 ? (
            <SidebarGroup>
              <SidebarGroupLabel>Analyze</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {analyzeItems.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        tooltip={item.label}
                        isActive={
                          pathname === item.href ||
                          pathname.startsWith(`${item.href}/`)
                        }
                        className={item.badge ? "pr-14" : undefined}
                      >
                        <Link href={item.href}>
                          <Icon icon={item.icon} className="size-4" />
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
          ) : null}
          <SidebarGroup>
            <SidebarGroupLabel>Manage</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {visibleNavItems.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      tooltip={item.label}
                      isActive={pathname.startsWith(item.href)}
                      className={item.badge ? "pr-14" : undefined}
                    >
                      <Link href={item.href}>
                        <Icon icon={item.icon} className="size-4" />
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
          {toolsItems.length > 0 ? (
            <SidebarGroup>
              <SidebarGroupLabel>Tools</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {toolsItems.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        tooltip={item.label}
                        isActive={
                          pathname === item.href ||
                          pathname.startsWith(`${item.href}/`)
                        }
                        className={item.badge ? "pr-14" : undefined}
                      >
                        <Link href={item.href}>
                          <Icon icon={item.icon} className="size-4" />
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
          ) : null}
          {isPrivileged ? (
            <SidebarGroup>
              <SidebarGroupLabel>API</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      tooltip="API Docs"
                      isActive={pathname.startsWith("/reference")}
                    >
                      <Link href="/reference">
                        <Icon icon="solar:book-2-linear" className="size-4" />
                        <span>API Docs</span>
                        <Icon
                          icon="solar:arrow-right-up-linear"
                          className="ml-auto size-3.5 text-muted-foreground"
                        />
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : null}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem className="flex items-center">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    tooltip={session?.user?.name ?? "User"}
                    className="min-w-0 flex-1"
                  >
                    <div className="flex size-5 items-center justify-center rounded-full bg-muted text-xs font-medium">
                      {session?.user?.name?.[0]?.toUpperCase() ?? "?"}
                    </div>
                    <span className="truncate">
                      {session?.user?.name ?? "User"}
                    </span>
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
                          <Icon icon="solar:buildings-2-linear" className="mr-2 size-4" />
                          Organization
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/settings/features">
                          <Icon icon="solar:tuning-2-linear" className="mr-2 size-4" />
                          Features
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/settings/members">
                          <Icon icon="solar:user-plus-linear" className="mr-2 size-4" />
                          Invite members
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/settings/api-keys">
                          <Icon icon="solar:key-linear" className="mr-2 size-4" />
                          API keys
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  <DropdownMenuItem onClick={handleSignOut}>
                    <Icon icon="solar:logout-2-linear" className="mr-2 size-4" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <div className="shrink-0 group-data-[collapsible=icon]:hidden">
                <ThemeToggle />
              </div>
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
