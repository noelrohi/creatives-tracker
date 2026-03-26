"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function OrgGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data: session, isPending: sessionPending } =
    authClient.useSession();
  const { data: orgs, isPending: orgsPending } =
    authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();

  useEffect(() => {
    if (sessionPending || orgsPending) return;

    // Not signed in — middleware handles redirect, but just in case
    if (!session) return;

    // No orgs at all — redirect to sign-up to create one
    if (orgs && orgs.length === 0) {
      router.push("/sign-up");
      return;
    }

    // Has orgs but no active org — set the first one as active
    if (orgs && orgs.length > 0 && !activeOrg) {
      void (async () => {
        await authClient.organization.setActive({ organizationId: orgs[0].id });
        router.refresh();
      })();
    }
  }, [session, orgs, activeOrg, sessionPending, orgsPending, router]);

  // Still loading
  if (sessionPending || orgsPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    );
  }

  // No active org yet (setting it)
  if (!activeOrg && orgs && orgs.length > 0) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    );
  }

  return <>{children}</>;
}
