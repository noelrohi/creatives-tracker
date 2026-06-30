"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { subDays } from "date-fns";
import { parseAsString, useQueryState } from "nuqs";
import { toast } from "sonner";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date";
import { isPrivilegedOrgRole } from "@/lib/organization-access";
import { useTRPC } from "@/lib/trpc/client";

export function useRecommendationsPageData() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { role, isPending: isRolePending } = useActiveOrganizationRole();
  const canWrite = !isRolePending && isPrivilegedOrgRole(role);

  const [tab, setTab] = useQueryState("tab", parseAsString.withDefault("winners"));
  const [accountId, setAccountId] = useQueryState("account", parseAsString.withDefault(""));
  const [teamId, setTeamId] = useQueryState("team", parseAsString.withDefault(""));
  const [from, setFrom] = useQueryState(
    "from",
    parseAsString.withDefault(formatDateOnly(subDays(new Date(), 29))),
  );
  const [to, setTo] = useQueryState(
    "to",
    parseAsString.withDefault(formatDateOnly(new Date())),
  );

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [playablePreview, setPlayablePreview] = useState<{
    creativeId: string;
    adId: string;
    name: string;
  } | null>(null);

  const fromValue = isDateOnlyString(from) ? from : formatDateOnly(subDays(new Date(), 29));
  const toValue = isDateOnlyString(to) ? to : formatDateOnly(new Date());
  const fromDate = parseDateOnly(fromValue);
  const toDate = parseDateOnly(toValue);
  const selectedAccountId = accountId || undefined;
  const selectedTeamId = teamId || undefined;

  const recommendationInput = useMemo(
    () => ({
      from: fromValue,
      to: toValue,
      accountId: selectedAccountId,
      teamId: selectedTeamId,
    }),
    [fromValue, toValue, selectedAccountId, selectedTeamId],
  );

  const accounts = useQuery(trpc.adAccount.list.queryOptions());
  const teams = useQuery(trpc.team.list.queryOptions());
  const candidates = useQuery(
    trpc.creativeRecommendation.listCandidates.queryOptions(recommendationInput),
  );
  const approvedVariants = useQuery(
    trpc.creativeRecommendation.listApprovedVariants.queryOptions(),
  );
  const adPreviewQuery = useQuery({
    ...trpc.adCreative.getAdPreviewUrl.queryOptions({
      id: playablePreview?.creativeId ?? "",
      adId: playablePreview?.adId,
    }),
    enabled: Boolean(playablePreview),
    staleTime: 1000 * 60 * 30,
  });

  const invalidateRecommendations = () => {
    queryClient.invalidateQueries({
      queryKey: trpc.creativeRecommendation.listCandidates.queryKey(recommendationInput),
    });
    queryClient.invalidateQueries({
      queryKey: trpc.creativeRecommendation.listApprovedVariants.queryKey(),
    });
  };

  const generateMutation = useMutation(
    trpc.creativeRecommendation.generateVariants.mutationOptions({
      onSuccess: (batch) => {
        toast.success("Generated 4 variants");
        setExpanded((prev) => new Set(prev).add(batch.sourceCreativeId));
        invalidateRecommendations();
      },
      onError: (error) => toast.error(error.message || "Failed to generate variants"),
    }),
  );

  const reviewMutation = useMutation(
    trpc.creativeRecommendation.reviewVariant.mutationOptions({
      onSuccess: invalidateRecommendations,
      onError: (error) => toast.error(error.message || "Failed to review variant"),
    }),
  );

  const toggleExpanded = (creativeId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(creativeId)) next.delete(creativeId);
      else next.add(creativeId);
      return next;
    });
  };

  const adPreviewUrl = adPreviewQuery.data?.previewUrl ?? null;
  const isAdPreviewLoading = adPreviewQuery.isLoading || (adPreviewQuery.isFetching && !adPreviewUrl);

  return {
    tab,
    setTab,
    accountId,
    setAccountId,
    teamId,
    setTeamId,
    fromValue,
    toValue,
    fromDate,
    toDate,
    setFrom,
    setTo,
    recommendationInput,
    accounts,
    teams,
    candidates,
    candidateRows: candidates.data ?? [],
    approvedVariants,
    approvedRows: approvedVariants.data ?? [],
    canWrite,
    isRolePending,
    expanded,
    toggleExpanded,
    playablePreview,
    setPlayablePreview,
    adPreviewQuery,
    adPreviewUrl,
    isAdPreviewLoading,
    generateMutation,
    reviewMutation,
  };
}
