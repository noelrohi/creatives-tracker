import type { RouterOutputs } from "@/lib/trpc/client";
import type { AwarenessLevel } from "@/lib/awareness";
import type { StudioFormat } from "@/lib/studio-prompt";

export type { AwarenessLevel, StudioFormat };

export type Starter = {
  brief: string;
  angle?: string;
  persona?: string;
  awarenessLevel?: AwarenessLevel;
  imageUrl?: string | null;
  creativeId?: string;
};

export type ComposerReference = {
  url: string;
  label: string;
  description?: string;
};

/** A newly submitted generation with credentials for its live Trigger.dev run. */
export type Generation = {
  generationId: string;
  runId: string;
  accessToken: string;
  brief: string;
  angle?: string;
  persona?: string;
  awarenessLevel?: AwarenessLevel;
  referenceImageUrls?: string[];
  count: number;
  format: StudioFormat;
  sourceCreativeId?: string;
};

export type GenerationSummary =
  RouterOutputs["studio"]["generations"][number];

export type GenerationPrefill = {
  brief: string;
  angle?: string | null;
  persona?: string | null;
  awarenessLevel?: AwarenessLevel | null;
  referenceImageUrls?: string[] | null;
  count: number;
  format: StudioFormat;
  sourceCreativeId?: string | null;
};
