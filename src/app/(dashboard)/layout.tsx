import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Script from "next/script";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { organization as orgTable } from "@/schema/auth";
import { eq } from "drizzle-orm";
import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/sign-in");
  }

  if (!session.session.activeOrganizationId) {
    redirect("/setup-org");
  }

  const [org] = await db
    .select()
    .from(orgTable)
    .where(eq(orgTable.id, session.session.activeOrganizationId));

  return (
    <SidebarProvider>
      <AppSidebar
        userName={session.user.name || session.user.email}
        orgName={org?.name ?? "Workspace"}
        orgId={session.session.activeOrganizationId}
      />
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger />
        </header>
        <main className="flex-1 p-6">{children}</main>
      </SidebarInset>
      {process.env.NODE_ENV === "development" && (
        <Script
          src="//unpkg.com/react-grab/dist/index.global.js"
          crossOrigin="anonymous"
          strategy="beforeInteractive"
        />
      )}
    </SidebarProvider>
  );
}
