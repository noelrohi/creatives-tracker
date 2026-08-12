/**
 * The funnel-stage voice, in one place.
 *
 * Both screens that speak about funnel stages — the attribution findings and
 * the creative-insights slices — used to carry their own copy of these maps,
 * which meant the same three stages could drift into three different sets of
 * words. The vocabulary itself (`tof` / `mof` / `bof`) is the wire identifier
 * from `@/lib/creative-taxonomy`; only the values below are ever printed.
 */

import { FUNNEL_STAGES, type FunnelStage } from "@/lib/creative-taxonomy";

export { FUNNEL_STAGES, type FunnelStage };

/** Narrow an unknown payload value to a stage we can speak about. */
export function isFunnelStage(value: unknown): value is FunnelStage {
  return (
    typeof value === "string" &&
    (FUNNEL_STAGES as readonly string[]).includes(value)
  );
}

/** Everything colder than the stage on record — the only honest "No" options. */
export function colderFunnelStages(stage: FunnelStage): FunnelStage[] {
  return FUNNEL_STAGES.slice(0, FUNNEL_STAGES.indexOf(stage));
}

/** The short label a breakdown row wears, where the column is already named. */
export const funnelStageLabels: Record<FunnelStage, string> = {
  tof: "TOF",
  mof: "MOF",
  bof: "BOF",
};

/** The plain name, for sentences that cannot lean on a column header. */
export const funnelStageNames: Record<FunnelStage, string> = {
  tof: "Cold",
  mof: "Warming",
  bof: "Ready to buy",
};

/** The long form, for sentences that need real words about real people. */
export const funnelStageWords: Record<FunnelStage, string> = {
  tof: "people meeting you for the first time",
  mof: "people weighing it up",
  bof: "people ready to buy",
};

/** What the `?` beside a stage says when you reach for it. */
export const funnelStageHelp: Record<FunnelStage, string> = {
  tof: "Top of funnel — people meeting you for the first time.",
  mof: "Middle of funnel — people who know you and are weighing it up.",
  bof: "Bottom of funnel — people ready to buy.",
};

/** The name, when the stage may be missing — a guess is never printed as fact. */
export function funnelStageName(stage: string | null | undefined): string {
  return isFunnelStage(stage) ? funnelStageNames[stage] : "not classified";
}

/** The long form, when the stage may be missing. */
export function funnelStageWordsFor(stage: string | null | undefined): string {
  return isFunnelStage(stage)
    ? funnelStageWords[stage]
    : "someone we can't place";
}
