import Script from "next/script";
import { AppSidebar } from "@/components/app-sidebar";
import { BreadcrumbsProvider } from "@/components/breadcrumbs";
import { OrgGuard } from "@/components/org-guard";
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <OrgGuard>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="h-svh md:peer-data-[variant=inset]:h-[calc(100svh-1rem)]">
          <BreadcrumbsProvider>
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
