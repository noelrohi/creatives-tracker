"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import { isPrivilegedOrgRole } from "@/lib/organization-access";
import { useTRPC } from "@/lib/trpc/client";
import { Clock, ArrowRight } from "@/components/icons";

function getDataAge(lastImportedAt: Date | null): number | null {
  if (!lastImportedAt) return null;
  return Math.floor(
    (Date.now() - new Date(lastImportedAt).getTime()) / 86400000,
  );
}

function getNextImportLabel(lastImportedAt: Date | null): string {
  if (!lastImportedAt) return "No imports yet";
  const last = new Date(lastImportedAt);
  const next = new Date(last.getTime() + 1 * 86400000);
  const now = Date.now();
  const diffMs = next.getTime() - now;

  if (diffMs <= 0) return "Now";

  const diffHours = Math.floor(diffMs / 3600000);
  if (diffHours < 1) return "Less than 1h";
  if (diffHours < 24) return `In ${diffHours}h`;
  const diffDays = Math.ceil(diffHours / 24);
  return `In ${diffDays}d`;
}

function formatAge(daysAgo: number): string {
  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "1 day ago";
  return `${daysAgo} days ago`;
}

export function ImportStatusBanner() {
  const trpc = useTRPC();
  const accounts = useQuery(trpc.adAccount.list.queryOptions());
  const { role } = useActiveOrganizationRole();
  const canImport = isPrivilegedOrgRole(role);

  const mostRecent = accounts.data
    ?.filter((a) => a.lastImportedAt)
    .sort(
      (a, b) =>
        new Date(b.lastImportedAt!).getTime() -
        new Date(a.lastImportedAt!).getTime(),
    )[0];

  const daysAgo = getDataAge(mostRecent?.lastImportedAt ?? null);
  const nextImport = getNextImportLabel(mostRecent?.lastImportedAt ?? null);
  const isOverdue = daysAgo != null && daysAgo >= 1;
  const hasData = daysAgo != null;

  if (accounts.isLoading) return null;

  const content = (
    <>
      <Clock
        className={`size-3.5 ${isOverdue ? "text-amber-500" : "text-muted-foreground/50"}`}
      />
      <div className="flex flex-1 items-center gap-4">
        <span className="text-muted-foreground">
          Last import:{" "}
          <span
            className={`font-medium ${isOverdue ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}
          >
            {hasData
              ? `${formatAge(daysAgo)}${mostRecent?.dataDateEnd ? ` (through ${mostRecent.dataDateEnd})` : ""}`
              : "Never"}
          </span>
        </span>
        <span className="text-muted-foreground/40">|</span>
        <span className="text-muted-foreground">
          Next recommended:{" "}
          <span
            className={`font-medium ${isOverdue ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}
          >
            {nextImport}
          </span>
        </span>
        <span className="text-muted-foreground/40">|</span>
        <span className="text-muted-foreground/50">
          Import daily with at least 3 days of data
        </span>
      </div>
      {canImport && <ArrowRight className="size-3 text-muted-foreground/40" />}
    </>
  );

  const className = `flex items-center gap-3 rounded-t-xl px-4 py-2 text-[13px] transition-colors ${
    isOverdue
      ? "bg-amber-500/10"
      : "bg-muted/30"
  }`;

  if (canImport) {
    return (
      <Link href="/import" className={`${className} hover:bg-amber-500/15`}>
        {content}
      </Link>
    );
  }

  return <div className={className}>{content}</div>;
}
