import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { auth as triggerAuth, tasks } from "@trigger.dev/sdk";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import type { metaSyncTask } from "../../../../trigger/meta-sync";

function metaSyncOrgTag(organizationId: string) {
  return `meta-sync:org:${organizationId}`;
}

function enabledMetaSyncOrganizationIds() {
  return new Set(
    (process.env.ADSOLUTE_META_SYNC_ORGANIZATION_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

function assertMetaSyncOrganizationEnabled(organizationId: string) {
  const enabledOrganizationIds = enabledMetaSyncOrganizationIds();
  if (enabledOrganizationIds.size > 0 && !enabledOrganizationIds.has(organizationId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Meta sync jobs are not enabled for this organization.",
    });
  }
}

export const triggerRouter = router({
  getPublicToken: orgProcedure.query(async ({ ctx }) => {
    const tag = metaSyncOrgTag(ctx.organizationId);
    const publicToken = await triggerAuth.createPublicToken({
      scopes: {
        read: {
          runs: true,
          tags: [tag],
        },
      },
      expirationTime: "1h",
    });

    return { publicToken, tag };
  }),

  triggerMetaSync: orgWriteProcedure
    .input(
      z.object({
        accountId: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        force: z.boolean().optional(),
        triggerType: z.enum(["scheduled", "manual_backfill"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      assertMetaSyncOrganizationEnabled(ctx.organizationId);

      const handle = await tasks.trigger<typeof metaSyncTask>("meta-sync", {
        organizationId: ctx.organizationId,
        accountId: input.accountId,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        force: input.force ?? false,
        triggerType: input.triggerType,
      });

      return { runId: handle.id };
    }),
});
