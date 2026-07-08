import type { AwarenessLevel } from "@/lib/awareness";

export type { AwarenessLevel };

export type Starter = {
  brief: string;
  angle?: string;
  persona?: string;
  awarenessLevel?: AwarenessLevel;
  imageUrl?: string | null;
};

export type ComposerReference = {
  url: string;
  label: string;
};

export type Generation = {
  runId: string;
  accessToken: string;
  brief: string;
  angle?: string;
  persona?: string;
  awarenessLevel?: AwarenessLevel;
  referenceImageUrls?: string[];
  count: number;
};
