import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { isOrgRole, type OrgRole } from "@/lib/organization-access";
import { member } from "@/schema/auth";

export async function getOrganizationRole(
  userId: string,
  organizationId: string,
): Promise<OrgRole | null> {
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.userId, userId),
        eq(member.organizationId, organizationId),
      ),
    )
    .limit(1);

  return isOrgRole(membership?.role) ? membership.role : null;
}
