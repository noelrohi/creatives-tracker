"use client";

import Link from "next/link";
import { Mail } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { isPrivilegedOrgRole } from "@/lib/organization-access";

/**
 * Privileged navigation only: hiding the link is UX, while every
 * `orgAdminProcedure` remains the security boundary for data and actions.
 */
export function KlaviyoLabLink({ role }: { role: string | null }) {
  if (
    !isPrivilegedOrgRole(role as Parameters<typeof isPrivilegedOrgRole>[0])
  ) {
    return null;
  }
  return (
    <Button asChild size="sm" variant="outline">
      <Link href="/attribution/klaviyo">
        <Mail className="size-4" />
        Klaviyo Lab
      </Link>
    </Button>
  );
}
