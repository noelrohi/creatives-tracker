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
};

export type Generation = {
  runId: string;
  accessToken: string;
  brief: string;
  angle?: string;
  persona?: string;
  awarenessLevel?: AwarenessLevel;
  count: number;
};
