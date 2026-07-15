import type { AwarenessLevel } from "@/lib/awareness";
import type { StudioFormat } from "@/lib/studio-prompt";

export type { AwarenessLevel, StudioFormat };

export type ComposerReference = {
  url: string;
  label: string;
  description?: string;
};
