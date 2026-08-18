import type { RouterOutputs } from "@/lib/trpc/client";

export type Competitor =
  RouterOutputs["signals"]["listCompetitors"]["items"][number];

export type TopCluster = Competitor["topClusters"][number];

export type ClusterTier = NonNullable<TopCluster["tier"]>;

export type RankedSignal =
  RouterOutputs["signals"]["rankedSignals"]["signals"][number];

export type CompetitorAdsData = RouterOutputs["signals"]["listCompetitorAds"];

export type CompetitorAd = CompetitorAdsData["ads"][number];

export type TestPlanConcept =
  RouterOutputs["signals"]["testPlan"]["concepts"][number];

export type TestPlanAd = TestPlanConcept["ads"][number];

export type TestPlanAdStatus = TestPlanAd["status"];

export type PlanRule = RouterOutputs["signals"]["planRules"]["rules"][number];
