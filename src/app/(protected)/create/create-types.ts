export type AwarenessLevel =
  | "unaware"
  | "problem_aware"
  | "solution_aware"
  | "product_aware"
  | "most_aware";

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
