import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import * as authSchema from "@/schema/auth";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
  emailAndPassword: { enabled: true },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const [membership] = await db
            .select({ organizationId: authSchema.member.organizationId })
            .from(authSchema.member)
            .where(eq(authSchema.member.userId, session.userId))
            .orderBy(asc(authSchema.member.createdAt))
            .limit(1);

          return {
            data: {
              ...session,
              activeOrganizationId:
                session.activeOrganizationId ??
                membership?.organizationId ??
                null,
            },
          };
        },
      },
    },
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: true,
    }),
  ],
});
