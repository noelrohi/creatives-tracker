import { auth } from "@/lib/auth";

// RFC 9728 protected-resource metadata lives at the site root, outside the
// /api/auth base path. Better Auth's MCP plugin answers it from an onRequest
// hook, so handing the request to the auth handler is enough.
export const GET = auth.handler;
export const HEAD = auth.handler;
