"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/lib/auth-client";
import {
  useListOrganizations,
  useSetActiveOrganization,
} from "@/hooks/use-organization";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  LayoutDashboard,
  Image,
  Globe,
  Megaphone,
  Layers,
  LogOut,
  Settings,
  ChevronsUpDown,
  Plus,
} from "lucide-react";

const navItems = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "Creatives", href: "/creatives", icon: Image },
  { label: "Landing Pages", href: "/landing-pages", icon: Globe },
  { label: "Campaigns", href: "/campaigns", icon: Megaphone },
  { label: "Ad Sets", href: "/ad-sets", icon: Layers },
  { label: "Settings", href: "/settings", icon: Settings },
];

interface AppSidebarProps {
  userName: string;
  orgName: string;
  orgId: string;
}

export function AppSidebar({ userName, orgName, orgId }: AppSidebarProps) {
  const pathname = usePathname();
  const orgsQuery = useListOrganizations();
  const setActiveMutation = useSetActiveOrganization();

  const orgs = orgsQuery.data ?? [];

  function switchOrg(organizationId: string) {
    setActiveMutation.mutate(
      { organizationId },
      { onSuccess: () => window.location.reload() },
    );
  }

  return (
    <Sidebar>
      <SidebarHeader>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
                {orgName.charAt(0).toUpperCase()}
              </div>
              <span className="flex-1 truncate text-sm font-semibold">
                {orgName}
              </span>
              <ChevronsUpDown className="size-4 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[240px]">
            <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {orgs.map((o) => (
              <DropdownMenuItem
                key={o.id}
                disabled={o.id === orgId}
                onSelect={() => {
                  if (o.id !== orgId) switchOrg(o.id);
                }}
              >
                <div className="flex size-6 shrink-0 items-center justify-center rounded bg-muted text-xs font-semibold">
                  {o.name.charAt(0).toUpperCase()}
                </div>
                <span className="truncate">{o.name}</span>
                {o.id === orgId && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    Active
                  </span>
                )}
              </DropdownMenuItem>
            ))}
            {orgsQuery.isSuccess && orgs.length === 0 && (
              <DropdownMenuItem disabled>
                <span className="text-sm text-muted-foreground">
                  No other workspaces
                </span>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/setup-org">
                <Plus className="size-4" />
                <span>Create workspace</span>
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={
                      item.href === "/"
                        ? pathname === "/"
                        : pathname.startsWith(item.href)
                    }
                  >
                    <Link href={item.href}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center justify-between px-2 py-1">
          <span className="truncate text-sm text-muted-foreground">
            {userName}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() =>
              signOut({
                fetchOptions: {
                  onSuccess: () => {
                    window.location.href = "/sign-in";
                  },
                },
              })
            }
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
