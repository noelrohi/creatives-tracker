import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { auth as triggerAuth, tasks } from "@trigger.dev/sdk";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import type { metaSyncTask } from "../../../../trigger/meta-sync";
import { formatDateOnly } from "@/lib/date";
import { baseWindowStart } from "@/lib/retention/policy";

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

export function clampMetaSyncDateFrom(dateFrom: string | undefined, today: string) {
  if (!dateFrom) return { dateFrom, clampedFrom: undefined };

  const windowStart = baseWindowStart(today);
  if (dateFrom >= windowStart) return { dateFrom, clampedFrom: undefined };
  return { dateFrom: windowStart, clampedFrom: windowStart };
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

      const { dateFrom, clampedFrom } = clampMetaSyncDateFrom(
        input.dateFrom,
        formatDateOnly(new Date()),
      );
      const handle = await tasks.trigger<typeof metaSyncTask>("meta-sync", {
        organizationId: ctx.organizationId,
        accountId: input.accountId,
        dateFrom,
        dateTo: input.dateTo,
        force: input.force ?? false,
        triggerType: input.triggerType,
      });

      return {
        runId: handle.id,
        ...(clampedFrom ? { clampedFrom } : {}),
      };
    }),
});
