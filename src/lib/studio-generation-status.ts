import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { studioGenerations, studioVariants } from "@/schema/studio";

export type StudioGenerationFinalStatus = "completed" | "failed";

export async function failStudioGeneration(
  generationId: string,
  organizationId: string,
) {
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(studioGenerations)
      .set({ status: "failed", updatedAt: now })
      .where(
        and(
          eq(studioGenerations.id, generationId),
          eq(studioGenerations.organizationId, organizationId),
        ),
      );
    await tx
      .update(studioVariants)
      .set({ status: "failed", updatedAt: now })
      .where(
        and(
          eq(studioVariants.generationId, generationId),
          eq(studioVariants.organizationId, organizationId),
          inArray(studioVariants.status, ["pending", "generating"]),
        ),
      );
  });
}

export async function finalizeStudioGenerationIfSettled(
  generationId: string,
  organizationId: string,
): Promise<StudioGenerationFinalStatus | null> {
  const rows = await db
    .select({ status: studioVariants.status })
    .from(studioVariants)
    .where(
      and(
        eq(studioVariants.generationId, generationId),
        eq(studioVariants.organizationId, organizationId),
      ),
    );

  if (
    rows.some((row) => row.status === "pending" || row.status === "generating")
  ) {
    return null;
  }

  const status = rows.some((row) => row.status === "ready")
    ? "completed"
    : "failed";
  await db
    .update(studioGenerations)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(studioGenerations.id, generationId),
        eq(studioGenerations.organizationId, organizationId),
      ),
    );

  return status;
}
