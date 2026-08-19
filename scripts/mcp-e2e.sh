#!/bin/bash
# End-to-end test of the MCP OAuth flow against a local dev server.
#
# Creates a throwaway user + org, registers an OAuth client via dynamic client
# registration (enabled outside production only), walks the authorization-code
# + PKCE flow with the consent endpoint, then calls the MCP server with the
# issued access token using the 2026-07-28 per-request envelope.
#
# Usage: bun dev  # in another terminal, then:
#        bash scripts/mcp-e2e.sh
set -euo pipefail
BASE=${BASE:-http://localhost:3000}
JAR=$(mktemp)
EMAIL="mcp-e2e-$RANDOM@example.com"
REDIRECT="http://127.0.0.1:6274/oauth/callback"
ENVELOPE='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"e2e","version":"1.0"}}'

read -r VERIFIER CHALLENGE <<<"$(python3 - <<'PY'
import base64, hashlib, secrets
v = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
c = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b"=").decode()
print(v, c)
PY
)"

echo "== 1. sign up test user ($EMAIL)"
curl -sf -c "$JAR" -X POST "$BASE/api/auth/sign-up/email" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"test-password-123\",\"name\":\"MCP E2E\"}" >/dev/null

echo "== 2. create org"
curl -sf -b "$JAR" -c "$JAR" -X POST "$BASE/api/auth/organization/create" \
  -H "origin: $BASE" -H 'content-type: application/json' \
  -d "{\"name\":\"E2E Org\",\"slug\":\"e2e-org-$RANDOM\"}" >/dev/null

echo "== 3. register OAuth client (dynamic client registration, native)"
CLIENT_ID=$(curl -sf -X POST "$BASE/api/auth/oauth2/register" -H 'content-type: application/json' \
  -d "{\"client_name\":\"e2e\",\"application_type\":\"native\",\"redirect_uris\":[\"$REDIRECT\"],\"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"],\"token_endpoint_auth_method\":\"none\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["client_id"])')
echo "   client_id=$CLIENT_ID"

echo "== 4. authorize (expect redirect to consent page)"
LOCATION=$(curl -s -b "$JAR" -o /dev/null -w '%{redirect_url}' -H 'accept: text/html' \
  "$BASE/api/auth/oauth2/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=$(python3 -c "from urllib.parse import quote; print(quote('$REDIRECT', safe=''))")&scope=openid%20profile%20email%20offline_access&state=xyz&code_challenge=$CHALLENGE&code_challenge_method=S256&resource=$(python3 -c "from urllib.parse import quote; print(quote('$BASE/api/mcp', safe=''))")")
case "$LOCATION" in
  */consent*) echo "   -> consent page" ;;
  */select-workspace*) echo "   -> workspace picker (multi-org user)"; exit 1 ;;
  *) echo "   unexpected redirect: $LOCATION"; exit 1 ;;
esac

echo "== 5. approve consent"
CODE_URL=$(curl -sf -b "$JAR" -X POST "$BASE/api/auth/oauth2/consent" \
  -H "origin: $BASE" -H 'content-type: application/json' \
  -d "{\"accept\":true,\"oauth_query\":\"${LOCATION#*\?}\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')
CODE=$(python3 -c "from urllib.parse import urlparse, parse_qs; print(parse_qs(urlparse('$CODE_URL').query)['code'][0])")

echo "== 6. exchange code for tokens"
AT=$(curl -sf -X POST "$BASE/api/auth/oauth2/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=authorization_code \
  --data-urlencode "code=$CODE" \
  --data-urlencode "redirect_uri=$REDIRECT" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "code_verifier=$VERIFIER" \
  --data-urlencode "resource=$BASE/api/mcp" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
echo "$AT" | python3 -c 'import base64,json,sys; p=sys.stdin.read().split(".")[1]; p+="="*(-len(p)%4); d=json.loads(base64.urlsafe_b64decode(p)); print("   claims:", {k:d.get(k) for k in ("sub","organization_id","scope")})'

echo "== 7. MCP tools/list + tools/call"
curl -sf -X POST "$BASE/api/mcp" -H "authorization: Bearer $AT" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-method: tools/list' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{$ENVELOPE}}" \
  | python3 -c 'import json,sys; print("   tools:", [t["name"] for t in json.load(sys.stdin)["result"]["tools"]])'

curl -sf -X POST "$BASE/api/mcp" -H "authorization: Bearer $AT" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-method: tools/call' -H 'mcp-name: list_campaigns' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"list_campaigns\",\"arguments\":{},$ENVELOPE}}" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; assert not r.get("isError"), r; print("   list_campaigns ->", r["content"][0]["text"][:100])'

echo "== PASS: full OAuth + MCP flow works"
