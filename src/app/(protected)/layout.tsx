import Script from "next/script";
import { AppSidebar } from "@/components/app-sidebar";
import { ImportStatusBanner } from "@/components/import-status-banner";
import { OrgGuard } from "@/components/org-guard";
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
        <AppSidebar />
        <SidebarInset>
          <ImportStatusBanner />
          <header className="flex h-12 items-center gap-2 border-b px-4">
            <SidebarTrigger />
          </header>
          <main className="min-w-0 flex-1 p-6">{children}</main>
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
