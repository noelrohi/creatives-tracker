// Serves files from STUDIO_LOCAL_STORAGE_DIR in development so the browser,
// the agent, and the image review can read locally stored Studio images. Off
// entirely when local storage is not configured.

import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import {
  contentTypeForKey,
  localStudioStorage,
  resolveInside,
} from "@/lib/studio-storage";

export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const local = localStudioStorage();
  if (!local) return new NextResponse("Not found", { status: 404 });
  const { path: segments } = await context.params;
  const key = segments.map(decodeURIComponent).join("/");
  const file = resolveInside(local.dir, key);
  if (!file) return new NextResponse("Not found", { status: 404 });
  try {
    const bytes = await readFile(file);
    return new NextResponse(bytes, {
      headers: {
        "content-type": contentTypeForKey(key),
        "cache-control": "no-store",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
