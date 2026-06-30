import type { CreativeVariantCopy } from "@/schema/creative-recommendation";

export function variantToText(copy: CreativeVariantCopy) {
  const lines = [
    copy.variantName,
    "",
    "PRIMARY TEXT",
    copy.primaryText,
    "",
    `HEADLINE: ${copy.headline}`,
    `HOOK: ${copy.hook}`,
    `CTA: ${copy.cta}`,
    `VISUAL: ${copy.visualDirection}`,
  ];
  return lines.join("\n");
}
