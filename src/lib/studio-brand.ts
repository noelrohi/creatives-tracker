import { eq } from "drizzle-orm";
import { db } from "@/db";
import { studioBrandProfiles } from "@/schema/studio";

export type StudioBrandProfile = {
  brandName: string;
  productDescription: string;
  offer: string | null;
  productImageUrl: string | null;
  productNotes: string | null;
};

export async function getStudioBrandProfile(
  organizationId: string,
): Promise<StudioBrandProfile | null> {
  const [row] = await db
    .select({
      brandName: studioBrandProfiles.brandName,
      productDescription: studioBrandProfiles.productDescription,
      offer: studioBrandProfiles.offer,
      productImageUrl: studioBrandProfiles.productImageUrl,
      productNotes: studioBrandProfiles.productNotes,
    })
    .from(studioBrandProfiles)
    .where(eq(studioBrandProfiles.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}
