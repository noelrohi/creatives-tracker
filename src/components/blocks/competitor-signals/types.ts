import type { RouterOutputs } from "@/lib/trpc/client";

export type Competitor =
  RouterOutputs["signals"]["listCompetitors"]["items"][number];

export type TopCluster = Competitor["topClusters"][number];

export type ClusterTier = NonNullable<TopCluster["tier"]>;

export type RankedSignal =
  RouterOutputs["signals"]["rankedSignals"]["signals"][number];

export type CompetitorAdsData = RouterOutputs["signals"]["listCompetitorAds"];

export type CompetitorAd = CompetitorAdsData["ads"][number];

/** Where an ad sits in the triage workflow — see the tabs on the ad grid. */
export type AdWorkflowStatus = CompetitorAd["workflowStatus"];

/** The tab order, checked against the server's union so a rename can't drift. */
export const AD_WORKFLOW_STATUSES = [
  "inbox",
  "shortlist",
  "deprioritised",
  "made",
] as const satisfies readonly AdWorkflowStatus[];

export type TestPlanConcept =
  RouterOutputs["signals"]["testPlan"]["concepts"][number];

export type TestPlanAd = TestPlanConcept["ads"][number];

export type TestPlanAdStatus = TestPlanAd["status"];

export type PlanRule = RouterOutputs["signals"]["planRules"]["rules"][number];
