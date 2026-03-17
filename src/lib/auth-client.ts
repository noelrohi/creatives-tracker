import { createAuthClient } from "better-auth/react";
import { organizationClient, adminClient } from "better-auth/client/plugins";

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  organization,
  admin,
} = createAuthClient({
  plugins: [organizationClient(), adminClient()],
});
