"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { LEDGER_REFRESH_KINDS } from "@/components/blocks/attribution/klaviyo/copy";
import { LedgerDetailSheet } from "@/components/blocks/attribution/klaviyo/ledger/ledger-detail-sheet";
import {
  LabRangeControls,
  LedgerFilters,
} from "@/components/blocks/attribution/klaviyo/ledger/ledger-filters";
import { LedgerSection } from "@/components/blocks/attribution/klaviyo/ledger/ledger-section";
import { LabPanelState } from "@/components/blocks/attribution/klaviyo/panel-state";
import { resolveLabDayRange } from "@/components/blocks/attribution/klaviyo/use-klaviyo-lab-state";
import { CloudDownload } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import { getUserFacingErrorMessage } from "@/lib/errors";
import { isPrivilegedOrgRole } from "@/lib/organization-access";
import { useTRPC } from "@/lib/trpc/client";
import { campaignsPage as copy } from "./campaigns-page.copy";
import { useLedgerPageState } from "./use-ledger-page-state";

const LAB_HREF = "/attribution/klaviyo";

/**
 * The front-and-center Klaviyo page: the campaign ledger for every org role.
 * Admin affordances (refresh, lab link, orders link) render only for
 * privileged roles; the data procedures themselves are org-readable and
 * aggregate-only, so hiding the controls is UX, not the security boundary.
 */
export function KlaviyoCampaignsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const page = useLedgerPageState();
  const { role } = useActiveOrganizationRole();
  const privileged = isPrivilegedOrgRole(role);

  const context = useQuery({
    ...trpc.klaviyo.ledgerContext.queryOptions(),
    retry: false,
  });
  const refresh = useMutation(
    trpc.klaviyo.refreshReports.mutationOptions({
      onSuccess: (result) => {
        toast.success(
          result.kind === "fresh" ? copy.refreshFresh : copy.refreshQueued,
        );
        void queryClient.invalidateQueries();
      },
      onError: (error) =>
        toast.error(getUserFacingErrorMessage(error, copy.refreshFailed)),
    }),
  );

  if (context.isError) {
    return (
      <div className="p-6">
        <LabPanelState
          kind="error"
          title={copy.error}
          body=""
          onRetry={() => void context.refetch()}
        />
      </div>
    );
  }
  if (!context.data) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!context.data.configured) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold">{copy.title}</h1>
        <div className="mt-6 flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-20">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted/50">
            <CloudDownload className="size-5 text-muted-foreground/40" />
          </div>
          <div className="text-center">
            <p className="text-sm text-muted-foreground">{copy.emptyTitle}</p>
            <p className="text-[13px] text-muted-foreground/40">
              {copy.emptyBody}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const { accountTimezone, todayInAccountTz: today } = context.data;
  const range = resolveLabDayRange({
    view: "ledger",
    range: page.state.range,
    from: page.state.from,
    to: page.state.to,
    storeToday: today,
    accountToday: today,
  });
  const publishedAt = context.data.lastMatchPublishedAt;

  const viewOrders = (objectId: string, sentDay: string | null) => {
    const params = new URLSearchParams({ view: "orders", source: objectId });
    if (sentDay) {
      params.set("range", "custom");
      params.set("from", sentDay);
    } else {
      params.set("range", "custom");
      params.set("from", range.dateFrom);
      params.set("to", range.dateTo);
    }
    router.push(`${LAB_HREF}?${params.toString()}`);
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{copy.title}</h1>
          <p className="text-sm text-muted-foreground">
            {context.data.accountName ?? "Klaviyo"}
            {publishedAt
              ? ` · ${copy.freshness(
                  formatDistanceToNow(new Date(publishedAt), {
                    addSuffix: true,
                  }),
                )}`
              : ""}
          </p>
        </div>
        {privileged ? (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" asChild>
              <Link href={LAB_HREF}>{copy.openLab}</Link>
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <LabRangeControls
          state={page.state}
          setState={page.setState}
          range={range}
          today={today}
          timezoneLabel={copy.timezoneLabel(accountTimezone)}
        />
        <LedgerFilters state={page.state} setState={page.setState} />
      </div>
      <LedgerSection
        range={range}
        accountTimezone={accountTimezone}
        state={page.state}
        onToggleSort={page.toggleSort}
        onOpenSource={page.openSource}
        onClearFilters={page.clearLedgerFilters}
        busy={refresh.isPending}
        onRefresh={
          privileged
            ? () =>
                refresh.mutate({
                  dateFrom: range.dateFrom,
                  dateTo: range.dateTo,
                  kinds: [...LEDGER_REFRESH_KINDS],
                })
            : undefined
        }
        refreshHint={privileged ? undefined : copy.refreshHint}
      />
      <LedgerDetailSheet
        objectId={page.state.source}
        range={range}
        onClose={page.closeSource}
        onViewOrders={privileged ? viewOrders : undefined}
      />
    </div>
  );
}
