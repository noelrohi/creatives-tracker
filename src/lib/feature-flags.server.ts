import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgSettings } from "@/schema/org-settings";
import type { FeatureFlags } from "@/lib/feature-flags";

/** Reads the org's stored flags. A missing settings row means every flag is off. */
export async function getOrgFeatureFlags(
  organizationId: string,
): Promise<FeatureFlags> {
  const [row] = await db
    .select({ featureFlags: orgSettings.featureFlags })
    .from(orgSettings)
    .where(eq(orgSettings.organizationId, organizationId))
    .limit(1);

  return (row?.featureFlags ?? {}) as FeatureFlags;
}

export async function isImageStudioEnabled(organizationId: string) {
  const flags = await getOrgFeatureFlags(organizationId);
  return flags.imageStudio === true;
}
