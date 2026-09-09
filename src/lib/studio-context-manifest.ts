import { z } from "zod";
import {
  STUDIO_CONTEXT_DOCUMENT_KINDS,
  STUDIO_CONTEXT_IMAGE_KINDS,
  STUDIO_CONTEXT_TIERS,
  type StudioContextDocumentKind,
  type StudioContextImageKind,
  type StudioContextTier,
} from "@/schema/studio";

export const manifestEntrySchema = z.object({
  file: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  kind: z.string().min(1),
  tier: z.enum(STUDIO_CONTEXT_TIERS).optional(),
});
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export type SeedFile = { path: string };

export type PlannedDocument = {
  sourceFilename: string;
  title: string;
  description: string;
  kind: StudioContextDocumentKind;
  tier: StudioContextTier;
  mimeType: "text/markdown" | "application/json" | "text/plain";
};

export type PlannedImage = {
  sourceFilename: string;
  title: string;
  description: string;
  kind: StudioContextImageKind;
};

export type SeedPlan =
  | { ok: true; documents: PlannedDocument[]; images: PlannedImage[]; skipped: string[] }
  | { ok: false; errors: string[] };

const DOCUMENT_MIME: Record<string, PlannedDocument["mimeType"]> = {
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  txt: "text/plain",
};
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

function normalizePath(file: string) {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function extensionOf(file: string) {
  const base = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

export function planContextSeed(entries: unknown[], files: SeedFile[]): SeedPlan {
  const errors: string[] = [];
  const parsed: ManifestEntry[] = [];
  entries.forEach((entry, index) => {
    const result = manifestEntrySchema.safeParse(entry);
    if (result.success) {
      parsed.push(result.data);
      return;
    }
    const file =
      typeof entry === "object" && entry && typeof (entry as { file?: unknown }).file === "string"
        ? ` (${(entry as { file: string }).file})`
        : "";
    const detail = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    errors.push(`entry ${index + 1}${file}: ${detail}`);
  });
  if (errors.length) return { ok: false, errors };

  const byPath = new Map(files.map((f) => [normalizePath(f.path), f]));
  const seen = new Set<string>();
  const documents: PlannedDocument[] = [];
  const images: PlannedImage[] = [];
  for (const entry of parsed) {
    const normalized = normalizePath(entry.file);
    if (seen.has(normalized)) {
      errors.push(`${entry.file}: listed more than once`);
      continue;
    }
    seen.add(normalized);
    if (!byPath.has(normalized)) {
      const nearby = [...byPath.keys()].find((p) => p.toLowerCase() === normalized.toLowerCase());
      errors.push(`${entry.file}: file not found${nearby ? ` (did you mean "${nearby}"?)` : ""}`);
      continue;
    }
    const ext = extensionOf(normalized);
    if (IMAGE_EXTENSIONS.has(ext)) {
      if (!(STUDIO_CONTEXT_IMAGE_KINDS as readonly string[]).includes(entry.kind)) {
        errors.push(`${entry.file}: kind "${entry.kind}" is not an image kind`);
        continue;
      }
      if (entry.tier) {
        errors.push(`${entry.file}: images do not take a tier`);
        continue;
      }
      images.push({
        sourceFilename: normalized,
        title: entry.title,
        description: entry.description,
        kind: entry.kind as StudioContextImageKind,
      });
      continue;
    }
    const mimeType = DOCUMENT_MIME[ext];
    if (!mimeType) {
      errors.push(`${entry.file}: unsupported file type${ext ? ` .${ext}` : ""}`);
      continue;
    }
    if (!(STUDIO_CONTEXT_DOCUMENT_KINDS as readonly string[]).includes(entry.kind)) {
      errors.push(`${entry.file}: kind "${entry.kind}" is not a document kind`);
      continue;
    }
    if (!entry.tier) {
      errors.push(`${entry.file}: documents need a tier (core or reference)`);
      continue;
    }
    documents.push({
      sourceFilename: normalized,
      title: entry.title,
      description: entry.description,
      kind: entry.kind as StudioContextDocumentKind,
      tier: entry.tier,
      mimeType,
    });
  }
  if (errors.length) return { ok: false, errors };
  const skipped = [...byPath.keys()].filter((path) => !seen.has(path));
  return { ok: true, documents, images, skipped };
}
