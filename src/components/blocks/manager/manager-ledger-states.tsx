"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { AlertCircle, CloudDownload, RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import { isPrivilegedOrgRole } from "@/lib/organization-access";
import { cn } from "@/lib/utils";

// chevron · name · status · 5 metrics · actions — keep in step with the header
// in manager-ledger.tsx so a full-width state row spans the whole ledger.
const LEDGER_COLUMN_COUNT = 9;

const ROW_HEIGHT = "h-[29px]";
const CELL = "px-2 py-0 text-[13px]";

// Inline states stay at the ledger row height (§9) so the table doesn't jump
// when a branch resolves to an error or to nothing.
function ManagerLedgerStateRow({ children }: { children: ReactNode }) {
  return (
    <TableRow className={cn(ROW_HEIGHT, "hover:bg-transparent")}>
      <TableCell colSpan={LEDGER_COLUMN_COUNT} className={CELL}>
        {children}
      </TableCell>
    </TableRow>
  );
}

// §9 "no campaigns at all": the unfiltered campaigns query came back empty, so
// no Meta account is connected or nothing has synced yet. Only owners/admins can
// act on that, so only they get the link (same gate as the sidebar's).
export function ManagerLedgerEmptyState() {
  const { role, isPending } = useActiveOrganizationRole();
  const canConnect = isPrivilegedOrgRole(role);

  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-20">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted/50">
        <CloudDownload className="size-5 text-muted-foreground/40" />
      </div>
      <div className="text-center">
        <p className="text-sm text-muted-foreground">No campaigns yet</p>
        {/* Held back until the role resolves — the two audiences get opposite
            instructions, and guessing wrong sends someone down a dead end. */}
        {!isPending && (
          <p className="text-[13px] text-muted-foreground/40">
            {canConnect
              ? "Connect a Meta account to pull campaigns, ad sets, and ads."
              : "Ask an admin to connect a Meta account."}
          </p>
        )}
      </div>
      {!isPending && canConnect && (
        <Button size="sm" variant="outline" asChild>
          <Link href="/accounts">Connect an account</Link>
        </Button>
      )}
    </div>
  );
}

// §9 "filters match nothing". Reachable only with status/search/account active —
// the date range zeroes metrics but never hides a row (§6), so an unfiltered
// empty result is always ManagerLedgerEmptyState instead.
export function ManagerLedgerNoResultsRow({ onClear }: { onClear: () => void }) {
  return (
    <ManagerLedgerStateRow>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <span>No results match your filters</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-[12px]"
          onClick={onClear}
        >
          Clear filters
        </Button>
      </div>
    </ManagerLedgerStateRow>
  );
}

// §9 query error, one per level: the branch that failed says so in place and
// retries itself, leaving the rest of the tree untouched.
export function ManagerLedgerErrorRow({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <ManagerLedgerStateRow>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <AlertCircle className="size-3.5 shrink-0 text-destructive/70" />
        <span>{message}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 gap-1 px-1.5 text-[12px]"
          onClick={onRetry}
        >
          <RefreshCw className="size-3" />
          Retry
        </Button>
      </div>
    </ManagerLedgerStateRow>
  );
}

// An expanded parent that resolves to no children says so rather than opening
// onto nothing — otherwise the chevron looks broken.
export function ManagerLedgerEmptyChildRow({ label }: { label: string }) {
  return (
    <ManagerLedgerStateRow>
      <span className="text-muted-foreground/60">{label}</span>
    </ManagerLedgerStateRow>
  );
}
