import { createHash } from "node:crypto";
import { put } from "@vercel/blob";
import { authenticateApiKey, getBearerToken } from "@/lib/api-keys";
import { auth } from "@/lib/auth";
import { isPrivilegedOrgRole } from "@/lib/organization-access";
import { getOrganizationRole } from "@/lib/server/organization-role";
import { headers } from "next/headers";

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  const hasBearerAuthorization = /^Bearer(?:\s|$)/i.test(authorization ?? "");

  if (hasBearerAuthorization) {
    const bearerToken = getBearerToken(authorization);
    const principal = bearerToken
      ? await authenticateApiKey(bearerToken)
      : null;

    if (!principal) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const scopes = principal.scopes.length > 0 ? principal.scopes : ["*"];
    if (!scopes.some((scope) => scope === "write" || scope === "*")) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
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
        { error: "Only organization admins can upload files" },
        { status: 403 },
      );
    }
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return Response.json({ error: "No file provided" }, { status: 400 });
  }

  const env = process.env.NODE_ENV === "production" ? "prod" : "dev";
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const path = `${env}/${crypto.randomUUID()}-${safeName}`;

  const hasher = createHash("sha256");
  const reader = file.stream().getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    hasher.update(value);
  }

  const hash = hasher.digest("hex");
  const blob = await put(path, file, {
    access: "public",
    allowOverwrite: true,
  });

  return Response.json({ url: blob.url, hash });
}
