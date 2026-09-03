// Where Studio images live. Production and the default dev path use Vercel
// Blob. Setting STUDIO_LOCAL_STORAGE_DIR (development only) writes the same
// objects to a folder in the repo and serves them from the dev server under
// /studio-local, so the whole variation pipeline can run without a Blob
// token or any public bucket.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { put } from "@vercel/blob";
import { fetchRemoteImage } from "@/lib/remote-image";

export type LocalStudioStorage = { dir: string; baseUrl: string };

export function localStudioStorage(): LocalStudioStorage | null {
  const dir = process.env.STUDIO_LOCAL_STORAGE_DIR?.trim();
  if (!dir || process.env.NODE_ENV === "production") return null;
  const baseUrl = (
    process.env.STUDIO_LOCAL_STORAGE_BASE_URL?.trim() ||
    "http://localhost:3000/studio-local"
  ).replace(/\/+$/, "");
  return { dir: path.resolve(dir), baseUrl };
}

/** Resolves a URL under the local base to a file path inside the storage dir, or null. */
export function localStudioPath(url: string): string | null {
  const local = localStudioStorage();
  if (!local || !url.startsWith(`${local.baseUrl}/`)) return null;
  return resolveInside(local.dir, decodeURIComponent(url.slice(local.baseUrl.length + 1)));
}

/** Joins a relative key onto the storage dir, refusing anything that escapes it. */
export function resolveInside(dir: string, key: string): string | null {
  const full = path.resolve(dir, key);
  return full === dir || full.startsWith(`${dir}${path.sep}`) ? full : null;
}

export async function putStudioObject(
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ url: string }> {
  const local = localStudioStorage();
  if (!local) {
    const blob = await put(key, Buffer.from(bytes), {
      access: "public",
      contentType,
      allowOverwrite: true,
    });
    return { url: blob.url };
  }
  const file = resolveInside(local.dir, key);
  if (!file) throw new Error(`Refusing to write outside the local storage dir: ${key}`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return { url: `${local.baseUrl}/${key.split("/").map(encodeURIComponent).join("/")}` };
}

/** Reads an image by URL: from disk when it lives in local storage, otherwise over HTTP. */
export async function readStudioImage(url: string): Promise<Uint8Array> {
  const file = localStudioPath(url);
  if (file) return new Uint8Array(await readFile(file));
  return fetchRemoteImage(url);
}

export function contentTypeForKey(key: string) {
  const extension = key.toLowerCase().split(".").pop() ?? "";
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}
