import Link from "next/link";
import { Clock, ArrowRight } from "lucide-react";

interface Account {
  lastImportedAt: Date | null;
  dataDateEnd: string | null;
}

function getDaysAgo(lastImportedAt: Date | null): number | null {
  if (!lastImportedAt) return null;
  return Math.floor((Date.now() - new Date(lastImportedAt).getTime()) / 86400000);
}

function formatAge(daysAgo: number): string {
  if (daysAgo === 0) return "today";
  if (daysAgo === 1) return "1d ago";
  return `${daysAgo}d ago`;
}

/**
 * Amber banner linking to /import. Only renders when data is stale (3+ days).
 */
export function StaleDataBanner({ account }: { account: Account | undefined }) {
  const daysAgo = getDaysAgo(account?.lastImportedAt ?? null);
  if (daysAgo == null || daysAgo < 3) return null;

  return (
    <Link
      href="/import"
      className="flex items-center gap-3 rounded-lg border border-dashed border-amber-500/30 bg-amber-500/5 px-4 py-3 transition-colors hover:bg-amber-500/10"
    >
      <Clock className="size-4 text-amber-500" />
      <p className="flex-1 text-sm">
        <span className="font-medium text-amber-600 dark:text-amber-400">
          Data is {daysAgo}d old
        </span>{" "}
        <span className="text-muted-foreground">
          (through {account?.dataDateEnd ?? "unknown"}) — import a fresh export to keep metrics current
        </span>
      </p>
      <ArrowRight className="size-3.5 text-muted-foreground" />
    </Link>
  );
}

/**
 * Compact inline label for tight spaces (e.g. performance section header).
 */
export function DataFreshnessLabel({ account }: { account: Account | undefined }) {
  const daysAgo = getDaysAgo(account?.lastImportedAt ?? null);
  if (daysAgo == null) return null;

  const stale = daysAgo >= 3;
  return (
    <span
      className={`flex items-center gap-1 text-[11px] ${
        stale ? "text-amber-500" : "text-muted-foreground/30"
      }`}
    >
      <Clock className="size-2.5" />
      {formatAge(daysAgo)}
    </span>
  );
}
