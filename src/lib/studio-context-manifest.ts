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

export type SeedFile = { path: string; size: number };

export type PlannedDocument = {
  file: string;
  title: string;
  description: string;
  kind: StudioContextDocumentKind;
  tier: StudioContextTier;
  mimeType: "text/markdown" | "application/json" | "text/plain";
};

export type PlannedImage = {
  file: string;
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

function extensionOf(file: string) {
  return file.toLowerCase().split(".").pop() ?? "";
}

export function planContextSeed(entries: unknown[], files: SeedFile[]): SeedPlan {
  const errors: string[] = [];
  const parsed: ManifestEntry[] = [];
  entries.forEach((entry, index) => {
    const result = manifestEntrySchema.safeParse(entry);
    if (result.success) parsed.push(result.data);
    else errors.push(`entry ${index + 1}: ${result.error.issues.map((i) => i.message).join("; ")}`);
  });
  if (errors.length) return { ok: false, errors };

  const byPath = new Map(files.map((f) => [f.path, f]));
  const seen = new Set<string>();
  const documents: PlannedDocument[] = [];
  const images: PlannedImage[] = [];
  for (const entry of parsed) {
    if (!byPath.has(entry.file)) {
      errors.push(`${entry.file}: file not found`);
      continue;
    }
    if (seen.has(entry.file)) {
      errors.push(`${entry.file}: listed more than once`);
      continue;
    }
    seen.add(entry.file);
    const ext = extensionOf(entry.file);
    if (IMAGE_EXTENSIONS.has(ext)) {
      if (!(STUDIO_CONTEXT_IMAGE_KINDS as readonly string[]).includes(entry.kind)) {
        errors.push(`${entry.file}: kind "${entry.kind}" is not an image kind`);
        continue;
      }
      images.push({
        file: entry.file,
        title: entry.title,
        description: entry.description,
        kind: entry.kind as StudioContextImageKind,
      });
      continue;
    }
    const mimeType = DOCUMENT_MIME[ext];
    if (!mimeType) {
      errors.push(`${entry.file}: unsupported file type .${ext}`);
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
      file: entry.file,
      title: entry.title,
      description: entry.description,
      kind: entry.kind as StudioContextDocumentKind,
      tier: entry.tier,
      mimeType,
    });
  }
  if (errors.length) return { ok: false, errors };
  const skipped = files.map((f) => f.path).filter((path) => !seen.has(path));
  return { ok: true, documents, images, skipped };
}
