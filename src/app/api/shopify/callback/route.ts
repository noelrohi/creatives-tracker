import { createHmac, timingSafeEqual } from "node:crypto";
import {
  SHOP_DOMAIN_PATTERN,
  SHOPIFY_STATE_COOKIE,
} from "@/lib/shopify-oauth";
import { cookies } from "next/headers";

function verifyHmac(searchParams: URLSearchParams, secret: string) {
  const hmac = searchParams.get("hmac");

  if (!hmac) {
    return false;
  }

  // Shopify signs the params byte-lexicographically sorted, with "&", "%",
  // and "=" (in keys) percent-escaped in the raw values.
  const escapeValue = (value: string) =>
    value.replace(/%/g, "%25").replace(/&/g, "%26");
  const escapeKey = (key: string) => escapeValue(key).replace(/=/g, "%3D");

  const message = [...searchParams.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .map(([key, value]) => `${escapeKey(key)}=${escapeValue(value)}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join("&");

  const digest = createHmac("sha256", secret).update(message).digest("hex");
  const digestBuffer = Buffer.from(digest, "utf8");
  const hmacBuffer = Buffer.from(hmac, "utf8");

  return (
    digestBuffer.length === hmacBuffer.length &&
    timingSafeEqual(digestBuffer, hmacBuffer)
  );
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const shop = searchParams.get("shop");
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return Response.json(
      { error: "SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set" },
      { status: 500 },
    );
  }

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(SHOPIFY_STATE_COOKIE)?.value;
  cookieStore.delete({ name: SHOPIFY_STATE_COOKIE, path: "/api/shopify" });

  if (!state || !expectedState || state !== expectedState) {
    return Response.json(
      { error: "OAuth state mismatch — restart the install" },
      { status: 400 },
    );
  }

  if (!shop || !SHOP_DOMAIN_PATTERN.test(shop) || !code) {
    return Response.json(
      { error: "Missing or invalid shop/code parameters" },
      { status: 400 },
    );
  }

  if (!verifyHmac(searchParams, clientSecret)) {
    return Response.json({ error: "HMAC verification failed" }, { status: 400 });
  }

  const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!tokenResponse.ok) {
    console.error(
      "Shopify token exchange failed",
      tokenResponse.status,
      await tokenResponse.text(),
    );
    return Response.json(
      { error: "Token exchange failed — see server logs" },
      { status: 502 },
    );
  }

  const { access_token: accessToken, scope } = (await tokenResponse.json()) as {
    access_token: string;
    scope: string;
  };

  // The token is shown exactly once, to the admin who initiated the install,
  // and is intentionally not persisted anywhere server-side (v1 keeps it in env).
  const html = `<!doctype html>
<title>Shopify install complete</title>
<body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto; line-height: 1.6">
  <h1>Shopify app installed on ${escapeHtml(shop)}</h1>
  <p>Granted scopes: <code>${escapeHtml(scope)}</code></p>
  <p>Add these to your environment (shown once — not stored anywhere):</p>
  <pre style="background:#f4f4f4;padding:1rem;border-radius:8px;overflow-x:auto">SHOPIFY_SHOP_DOMAIN=${escapeHtml(shop)}
SHOPIFY_ACCESS_TOKEN=${escapeHtml(accessToken)}</pre>
  <p>Then close this tab.</p>
</body>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
