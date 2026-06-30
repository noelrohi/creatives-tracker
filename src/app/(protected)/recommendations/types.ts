import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/lib/trpc/routers/_app";

type CreativeRecommendationOutputs = inferRouterOutputs<AppRouter>["creativeRecommendation"];

export type RecommendationCandidate = CreativeRecommendationOutputs["listCandidates"][number];
export type ApprovedVariantRow = CreativeRecommendationOutputs["listApprovedVariants"][number];
export type RecommendationVariant = ApprovedVariantRow["variant"];
