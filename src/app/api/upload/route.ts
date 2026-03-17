import { put } from "@vercel/blob";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export async function POST(request: Request) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return Response.json({ error: "No file provided" }, { status: 400 });
  }

  const env = process.env.NODE_ENV === "production" ? "prod" : "dev";
  const path = `${env}/${file.name}`;

  const blob = await put(path, file, {
    access: "public",
  });

  return Response.json({ url: blob.url });
}
