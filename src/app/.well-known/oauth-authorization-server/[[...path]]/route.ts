import { auth } from "@/lib/auth";

// RFC 8414 authorization-server metadata for issuer path /api/auth resolves
// to /.well-known/oauth-authorization-server/api/auth at the site root.
// Better Auth's OAuth provider answers it from an onRequest hook.
export const GET = auth.handler;
export const HEAD = auth.handler;
