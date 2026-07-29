import { auth } from "@/lib/auth";
import { isPrivilegedOrgRole } from "@/lib/organization-access";
import { getOrganizationRole } from "@/lib/server/organization-role";
import {
  SHOP_DOMAIN_PATTERN,
  SHOPIFY_STATE_COOKIE,
} from "@/lib/shopify-oauth";
import { cookies, headers } from "next/headers";

export async function GET(request: Request) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const organizationId = session.session.activeOrganizationId;

  if (!organizationId) {
    return Response.json(
      { error: "No active organization selected" },
      { status: 403 },
    );
  }

  const role = await getOrganizationRole(session.user.id, organizationId);

  if (!isPrivilegedOrgRole(role)) {
    return Response.json(
      { error: "Only organization admins can install the Shopify app" },
      { status: 403 },
    );
  }

  const shop = new URL(request.url).searchParams.get("shop");

  if (!shop || !SHOP_DOMAIN_PATTERN.test(shop)) {
    return Response.json(
      { error: "Provide ?shop=<store>.myshopify.com" },
      { status: 400 },
    );
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const appUrl = process.env.BETTER_AUTH_URL;

  if (!clientId || !appUrl) {
    return Response.json(
      { error: "SHOPIFY_CLIENT_ID and BETTER_AUTH_URL must be set" },
      { status: 500 },
    );
  }

  const state = crypto.randomUUID();
  const cookieStore = await cookies();
  cookieStore.set(SHOPIFY_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: appUrl.startsWith("https://"),
    path: "/api/shopify",
    maxAge: 600,
  });

  const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set(
    "scope",
    process.env.SHOPIFY_SCOPES ?? "read_orders",
  );
  authorizeUrl.searchParams.set("redirect_uri", `${appUrl}/api/shopify/callback`);
  authorizeUrl.searchParams.set("state", state);

  return Response.redirect(authorizeUrl, 302);
}
