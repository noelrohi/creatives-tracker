import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  // oauthProviderClient also attaches the signed OAuth query from
  // window.location.search to auth requests, which is what lets the sign-in
  // and consent pages resume an in-flight MCP authorization flow.
  plugins: [organizationClient(), oauthProviderClient()],
});
