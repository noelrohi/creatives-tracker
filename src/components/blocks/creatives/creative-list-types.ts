import type { CreativeHealth } from "@/lib/creative-health";

export interface Creative {
  id: string;
  name: string;
  assetUrl: string | null;
  videoUrl: string | null;
  destinationUrl: string | null;
  format: string | null;
  angle: string | null;
  persona: string | null;
  awarenessLevel: string | null;
  hook: string | null;
  tone: string[] | null;
  cta: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  firstSeen: string | null;
  totalSpend: string | null;
  avgRoas: string | null;
  avgCpa: string | null;
  avgCtr: string | null;
  totalConversions: number | null;
  adStatus: string | null;
  metaAdId: string | null;
  metaCampaignId: string | null;
  metaAdSetId: string | null;
  accountName: string | null;
  teamId: string | null;
  // Trend metrics for health
  recentCtr: string | null;
  recentCpc: string | null;
  avgCpc: string | null;
  avgFrequency: string | null;
  recentHookRate: string | null;
  priorHookRate: string | null;
  recentCpa: string | null;
  thumbstopRatio: string | null;
  health: CreativeHealth | null;
  healthReasons: string[];
}
