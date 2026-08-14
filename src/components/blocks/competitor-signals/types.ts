import type { RouterOutputs } from "@/lib/trpc/client";

export type Competitor =
  RouterOutputs["signals"]["listCompetitors"]["items"][number];

export type TopCluster = Competitor["topClusters"][number];

export type ClusterTier = NonNullable<TopCluster["tier"]>;

export type RankedSignal =
  RouterOutputs["signals"]["rankedSignals"]["signals"][number];
