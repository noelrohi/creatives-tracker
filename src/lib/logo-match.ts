// Decides whether the brand's uploaded logo asset is the same lockup as the
// mark in the source ad. Per feature rather than one similarity score: a
// single number confidently rates the wrong mark as close. Pure: the vision
// call lives in the trigger.
import { z } from "zod";

const agreement = z.enum(["same", "different", "absent_in_both"]);

export const logoMatchSchema = z.object({
  wordmark: agreement.describe("The brand name set as type."),
  icon: agreement.describe("The symbol, monogram, or emblem, if any."),
  orientation: z.enum(["same", "different"]).describe("Horizontal lockup versus stacked."),
  colourway: z.enum(["same", "different"]).describe("Full colour, mono, reversed."),
  note: z.string(),
});

export type LogoMatch = z.infer<typeof logoMatchSchema>;

export function buildLogoMatchPrompt(brandName: string | null) {
  return [
    `Image 1 is a crop of the brand mark from an existing ad${brandName ? ` for ${brandName}` : ""}. Image 2 is the brand's uploaded logo file.`,
    "Compare them feature by feature and answer each separately.",
    "wordmark: does image 2 set the same brand name in the same typeface as image 1? absent_in_both when neither shows type.",
    "icon: does image 2 show the same symbol, monogram, or emblem? absent_in_both when neither shows one.",
    "orientation: same when both are laid out the same way (both horizontal, or both stacked), different otherwise.",
    "colourway: same when both use the same colours, different for a mono, reversed, or recoloured version of the same mark.",
    "note: one sentence on anything that would make a designer call these different marks.",
  ].join("\n");
}

/**
 * The asset stands in for the source's mark when the wordmark and the icon
 * agree, and at least one of them was actually recognised: a crop the model
 * cannot read answers "absent in both" to everything, which verifies nothing
 * and must not license a paste. Orientation and colourway may differ: those
 * are the variants the contrast step chooses between, and disqualifying them
 * would reject a brand's own reversed logo.
 */
export function assetIsSameLockup(result: LogoMatch): boolean {
  return (
    (result.wordmark === "same" || result.icon === "same") &&
    result.wordmark !== "different" &&
    result.icon !== "different"
  );
}
