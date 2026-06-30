"use client";

import { Check, Loader2, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DateRangePicker } from "@/components/blocks/dashboard/date-range-picker";
import { formatDateOnly } from "@/lib/date";
import { ApprovedVariantsList } from "./approved-variants-list";
import { EmptyState, LoadError, WinnerSkeleton } from "./recommendation-ui";
import { useRecommendationsPageData } from "./use-recommendations-page-data";
import { WinnerCard } from "./winner-card";
import { WinnerCriteriaPopover } from "./winner-criteria-popover";

export function RecommendationsPageClient() {
  const page = useRecommendationsPageData();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-lg font-semibold tracking-tight">Recommendations</h1>
            <WinnerCriteriaPopover />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Find your winning static ads, spin up 3–4 static variants, and approve the ones worth making.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker
            from={page.fromDate}
            to={page.toDate}
            onChange={(range) => {
              if (range) {
                page.setFrom(formatDateOnly(range.from));
                page.setTo(formatDateOnly(range.to));
              }
            }}
          />
          {page.accounts.data && page.accounts.data.length > 0 ? (
            <Select
              value={page.accountId || "all"}
              onValueChange={(value) => page.setAccountId(value === "all" ? "" : value)}
            >
              <SelectTrigger className="h-7 w-auto gap-1 text-[13px]">
                <SelectValue placeholder="All accounts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                {page.accounts.data.map((account) => (
                  <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {page.teams.data && page.teams.data.length > 0 ? (
            <Select
              value={page.teamId || "all"}
              onValueChange={(value) => page.setTeamId(value === "all" ? "" : value)}
            >
              <SelectTrigger className="h-7 w-auto gap-1 text-[13px]">
                <SelectValue placeholder="All teams" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All teams</SelectItem>
                {page.teams.data.map((team) => (
                  <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </div>

      <Tabs value={page.tab} onValueChange={page.setTab}>
        <TabsList variant="line">
          <TabsTrigger value="winners" className="gap-1.5">
            <Sparkles className="size-3.5" /> Winners
          </TabsTrigger>
          <TabsTrigger value="approved" className="gap-1.5">
            <Check className="size-3.5" /> Approved
            {page.approvedRows.length > 0 ? (
              <span className="ml-0.5 rounded-full bg-emerald-500/15 px-1.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                {page.approvedRows.length}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {page.tab === "winners" ? (
        <section className="flex flex-col gap-3">
          {page.candidates.isLoading ? (
            <WinnerSkeleton />
          ) : page.candidates.isError ? (
            <LoadError title="Could not load winners" message={page.candidates.error.message} />
          ) : page.candidateRows.length === 0 ? (
            <EmptyState>
              No active static winners meet the thresholds in this window. Try a wider date range, or import
              more recent performance data.
            </EmptyState>
          ) : (
            page.candidateRows.map((candidate) => {
              const isOpen = page.expanded.has(candidate.sourceCreativeId);
              const generating =
                page.generateMutation.isPending &&
                page.generateMutation.variables?.sourceCreativeId === candidate.sourceCreativeId;

              return (
                <WinnerCard
                  key={`${candidate.sourceCreativeId}-${candidate.sourceAdId}`}
                  candidate={candidate}
                  fromValue={page.fromValue}
                  toValue={page.toValue}
                  isOpen={isOpen}
                  canWrite={page.canWrite}
                  generating={generating}
                  reviewPending={page.reviewMutation.isPending}
                  onToggle={() => page.toggleExpanded(candidate.sourceCreativeId)}
                  onGenerate={() =>
                    page.generateMutation.mutate({
                      ...page.recommendationInput,
                      sourceCreativeId: candidate.sourceCreativeId,
                      sourceAdId: candidate.sourceAdId,
                    })
                  }
                  onReview={(review) => page.reviewMutation.mutate(review)}
                  onOpenPlayable={() =>
                    page.setPlayablePreview({
                      creativeId: candidate.sourceCreativeId,
                      adId: candidate.sourceAdId,
                      name: candidate.sourceCreativeName,
                    })
                  }
                />
              );
            })
          )}
        </section>
      ) : (
        <ApprovedVariantsList
          approvedRows={page.approvedRows}
          isLoading={page.approvedVariants.isLoading}
          isError={page.approvedVariants.isError}
          errorMessage={page.approvedVariants.error?.message}
        />
      )}

      <Dialog
        open={Boolean(page.playablePreview)}
        onOpenChange={(open) => {
          if (!open) page.setPlayablePreview(null);
        }}
      >
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[360px]">
          <DialogHeader className="px-4 pb-3 pt-4">
            <DialogTitle className="truncate text-sm">
              {page.playablePreview?.name ?? "Ad Preview"}
            </DialogTitle>
          </DialogHeader>
          {page.isAdPreviewLoading ? (
            <div className="flex aspect-[9/16] w-full items-center justify-center bg-muted/20">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : page.adPreviewQuery.isError ? (
            <div className="flex aspect-[9/16] w-full items-center justify-center bg-muted/20 px-6 text-center text-sm text-muted-foreground">
              Could not load the Meta preview.
            </div>
          ) : page.adPreviewUrl ? (
            <div className="bg-white">
              <iframe
                src={page.adPreviewUrl}
                title={page.playablePreview ? `Meta preview for ${page.playablePreview.name}` : "Meta preview"}
                className="aspect-[9/16] w-full border-none"
                scrolling="yes"
              />
            </div>
          ) : (
            <div className="flex aspect-[9/16] w-full items-center justify-center bg-muted/20 px-6 text-center text-sm text-muted-foreground">
              Meta preview is not available for this ad.
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
