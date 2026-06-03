import Script from "next/script";
import { AppSidebar } from "@/components/app-sidebar";
import { BreadcrumbsProvider, HeaderBreadcrumbs } from "@/components/breadcrumbs";
import { ImportStatusBanner } from "@/components/import-status-banner";
import { isLaunchpadEnabled } from "@/lib/feature-flags";
import { OrgGuard } from "@/components/org-guard";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <OrgGuard>
      <SidebarProvider>
        <AppSidebar launchpadEnabled={isLaunchpadEnabled()} />
        <SidebarInset className="h-svh md:peer-data-[variant=inset]:h-[calc(100svh-1rem)]">
          <BreadcrumbsProvider>
            <ImportStatusBanner />
            <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
              <SidebarTrigger />
              <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center" />
              <HeaderBreadcrumbs />
              <div className="ml-auto flex items-center gap-2">
                <ThemeToggle />
              </div>
            </header>
            <main className="min-w-0 flex-1 overflow-y-auto p-6">{children}</main>
          </BreadcrumbsProvider>
        </SidebarInset>
        {process.env.NODE_ENV === "development" && (
          <Script
            src="//unpkg.com/react-grab/dist/index.global.js"
            crossOrigin="anonymous"
            strategy="beforeInteractive"
          />
        )}
      </SidebarProvider>
    </OrgGuard>
  );
}
