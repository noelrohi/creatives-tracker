import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isImageStudioEnabled } from "@/lib/feature-flags.server";
import { StudioNav } from "./studio-nav";

export default async function StudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  const organizationId = session?.session?.activeOrganizationId ?? null;
  if (!organizationId) redirect("/");
  if (!(await isImageStudioEnabled(organizationId))) redirect("/");

  return (
    <div className="flex h-full flex-col gap-4">
      <StudioNav />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
