import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { router, orgProcedure, orgAdminProcedure } from "../init";
import { db } from "@/db";
import { orgSettings } from "@/schema/org-settings";
import { featureFlagKeys, type FeatureFlags } from "@/lib/feature-flags";

const setFeatureFlagInput = z.object({
  key: z.enum(featureFlagKeys),
  enabled: z.boolean(),
});

export const orgSettingsRouter = router({
  getFeatureFlags: orgProcedure.query(async ({ ctx }) => {
    const [row] = await db
      .select({ featureFlags: orgSettings.featureFlags })
      .from(orgSettings)
      .where(eq(orgSettings.organizationId, ctx.organizationId))
      .limit(1);

    return (row?.featureFlags ?? {}) as FeatureFlags;
  }),

  setFeatureFlag: orgAdminProcedure
    .input(setFeatureFlagInput)
    .mutation(async ({ input, ctx }) => {
      const patch: FeatureFlags = { [input.key]: input.enabled };

      const [updated] = await db
        .insert(orgSettings)
        .values({
          organizationId: ctx.organizationId,
          featureFlags: patch,
        })
        .onConflictDoUpdate({
          target: orgSettings.organizationId,
          set: {
            // Merge the single key into whatever is already stored.
            featureFlags: sql`${orgSettings.featureFlags} || ${JSON.stringify(patch)}::jsonb`,
            updatedAt: new Date(),
          },
        })
        .returning({ featureFlags: orgSettings.featureFlags });

      return (updated?.featureFlags ?? {}) as FeatureFlags;
    }),
});
