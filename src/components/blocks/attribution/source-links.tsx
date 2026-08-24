"use client";

import Link from "next/link";
import { Mail, MousePointerClick, Search } from "@/components/icons";
import { Button } from "@/components/ui/button";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { isPrivilegedOrgRole } from "@/lib/organization-access";
import { cn } from "@/lib/utils";

/**
 * The way into each source's own screen, one map for every place that offers
 * it. Meta's dashboard is for every role; the labs are privileged navigation
 * only — hiding them is UX, the `orgAdminProcedure` on their data remains the
 * security boundary. Buckets missing from this map have no screen of their own.
 */
const SOURCE_LINKS: Partial<
  Record<
    AttributionBucket,
    {
      href: string;
      label: string;
      Icon: typeof MousePointerClick;
      privileged: boolean;
    }
  >
> = {
  meta: {
    href: "/meta",
    label: "Meta dashboard",
    Icon: MousePointerClick,
    privileged: false,
  },
  google: {
    href: "/attribution/google-ads",
    label: "Google Ads Lab",
    Icon: Search,
    privileged: true,
  },
  klaviyo: {
    href: "/attribution/klaviyo",
    label: "Klaviyo Lab",
    Icon: Mail,
    privileged: true,
  },
};

/**
 * Compact by default so it can sit inside a ledger row without growing it;
 * `className` lets a roomier host restyle it.
 */
export function SourceActionLink({
  bucket,
  role,
  className,
}: {
  bucket: AttributionBucket;
  role: string | null;
  className?: string;
}) {
  const link = SOURCE_LINKS[bucket];
  if (!link) return null;
  if (
    link.privileged &&
    !isPrivilegedOrgRole(role as Parameters<typeof isPrivilegedOrgRole>[0])
  ) {
    return null;
  }

  return (
    <Button
      asChild
      size="sm"
      variant="outline"
      className={cn("h-6 gap-1 bg-card px-1.5 text-[11px] font-medium", className)}
    >
      <Link href={link.href}>
        <link.Icon className="size-3" />
        {link.label}
      </Link>
    </Button>
  );
}
