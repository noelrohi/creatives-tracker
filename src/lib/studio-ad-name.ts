import { studioSlug } from "@/lib/studio-taxonomy";

type BuildAdNameInput = {
  brandName?: string | null;
  angle?: string | null;
  variantId: string;
};

const TEMPLATE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-ST-[a-z0-9]+(?:-[a-z0-9]+)*-([a-z0-9]{6})$/i;

export function studioAdNameId(variantId: string) {
  return variantId.replaceAll("-", "").slice(0, 6).toLowerCase();
}

export function studioAdNameSlug(value: string) {
  return studioSlug(value.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""));
}

export function buildAdName({ brandName, angle, variantId }: BuildAdNameInput) {
  const brand = studioAdNameSlug(brandName ?? "").toUpperCase() || "STUDIO";
  const angleSlug = studioAdNameSlug(angle ?? "") || "untagged";
  return `${brand}-ST-${angleSlug}-${studioAdNameId(variantId)}`;
}

export function extractAdNameId(name: string) {
  return name.match(TEMPLATE_ID_PATTERN)?.[1]?.toLowerCase() ?? null;
}
