"use client";

import Link from "next/link";
import { Search } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { isPrivilegedOrgRole } from "@/lib/organization-access";

/**
 * Privileged navigation only: hiding the link is UX, while every
 * `orgAdminProcedure` remains the security boundary for data and actions.
 */
export function GoogleAdsLabLink({ role }: { role: string | null }) {
  if (
    !isPrivilegedOrgRole(role as Parameters<typeof isPrivilegedOrgRole>[0])
  ) {
    return null;
  }
  return (
    <Button asChild size="sm" variant="outline">
      <Link href="/attribution/google-ads">
        <Search className="size-4" />
        Google Ads Lab
      </Link>
    </Button>
  );
}
