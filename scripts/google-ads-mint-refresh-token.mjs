#!/usr/bin/env node
/**
 * One-time OAuth consent helper for the Google Ads pilot.
 *
 * Usage:
 *   GOOGLE_ADS_OAUTH_CLIENT_ID=... GOOGLE_ADS_OAUTH_CLIENT_SECRET=... \
 *     node scripts/google-ads-mint-refresh-token.mjs
 *
 * Starts a loopback listener, prints the consent URL, exchanges the code,
 * and prints the refresh token to paste into GOOGLE_ADS_REFRESH_TOKEN.
 * The OAuth client must be a Desktop-app client (loopback redirects are
 * accepted automatically) or have http://127.0.0.1:53682 as an authorized
 * redirect URI.
 */
import http from "node:http";
import crypto from "node:crypto";

const clientId = process.env.GOOGLE_ADS_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_ADS_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_ADS_OAUTH_CLIENT_ID and GOOGLE_ADS_OAUTH_CLIENT_SECRET");
  process.exit(1);
}

const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/adwords";
const state = crypto.randomBytes(16).toString("hex");

const consentUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
consentUrl.searchParams.set("client_id", clientId);
consentUrl.searchParams.set("redirect_uri", REDIRECT_URI);
consentUrl.searchParams.set("response_type", "code");
consentUrl.searchParams.set("scope", SCOPE);
consentUrl.searchParams.set("access_type", "offline");
consentUrl.searchParams.set("prompt", "consent");
consentUrl.searchParams.set("state", state);

let handled = false;

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", REDIRECT_URI);
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.get("state") !== state) {
    response.writeHead(400).end("Missing code or state mismatch.");
    return;
  }
  if (handled) {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("Already processed.");
    return;
  }
  handled = true;

  response.writeHead(200, { "content-type": "text/plain" });
  response.end("Consent received — return to the terminal. You can close this tab.");
  server.close();

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });
    const payload = await tokenResponse.json();
    if (!tokenResponse.ok || !payload.refresh_token) {
      console.error(
        "Token exchange failed:",
        tokenResponse.status,
        payload.error ?? "",
        payload.error_description ?? "",
      );
      process.exit(1);
    }
    console.log("\nGOOGLE_ADS_REFRESH_TOKEN:\n");
    console.log(payload.refresh_token);
    console.log("\nPaste it into the server/worker environment. Never commit it.");
  } catch (error) {
    console.error(`Token exchange failed: ${error.message}`);
    process.exit(1);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Open this URL in a browser logged into the Google account");
  console.log("that has access to the (test) manager account:\n");
  console.log(consentUrl.toString());
});
