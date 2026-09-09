/**
 * Seed an organization's Studio context library from a local folder.
 *
 * Usage: bun scripts/seed-studio-context.ts --org <organizationId> --dir <path> [--dry-run]
 *
 * The folder must hold a `context-manifest.json`: an array of
 * { file, title, description, kind, tier? } entries (paths relative to the
 * folder). Documents (.md/.json/.txt) need a tier: "core" is inlined into every
 * agent run, "reference" is read on demand by section. Images
 * (.png/.jpg/.jpeg/.webp/.gif) are uploaded to Blob. Files not in the manifest
 * are skipped with a warning; PDFs are never ingested.
 *
 * `--dry-run` validates the manifest, sections the reference documents, and
 * reads image headers, printing the same summary, without touching the
 * database or Blob.
 *
 * Safe to re-run: documents and images upsert by (org, sourceFilename) and
 * sections are regenerated for every reference document.
 *
 * Run with NODE_ENV=production when DATABASE_URL points at production so
 * Blob keys land under prod/.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { readImageDimensions } from "@/lib/image-dimensions";
import { planContextSeed, type SeedFile } from "@/lib/studio-context-manifest";
import { sectionDocument } from "@/lib/studio-context-sections";
import { contentTypeForKey, putStudioObject } from "@/lib/studio-storage";
import {
  studioContextDocuments,
  studioContextImages,
  studioContextSections,
} from "@/schema/studio";

const blobEnvPrefix = process.env.NODE_ENV === "production" ? "prod" : "dev";

function flag(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const organizationId = flag("--org");
const dir = flag("--dir");
const dryRun = process.argv.includes("--dry-run");
if (!organizationId || !dir) {
  console.error(
    "Usage: bun scripts/seed-studio-context.ts --org <organizationId> --dir <path> [--dry-run]",
  );
  process.exit(1);
}

async function listFiles(root: string): Promise<SeedFile[]> {
  const out: SeedFile[] = [];
  async function walk(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const path = relative(root, full);
      if (path === "context-manifest.json") continue;
      out.push({ path });
    }
  }
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function main(organizationId: string, dir: string) {
  const manifestRaw = await readFile(join(dir, "context-manifest.json"), "utf8");
  const entries = JSON.parse(manifestRaw);
  if (!Array.isArray(entries)) throw new Error("context-manifest.json must be an array");
  const files = await listFiles(dir);
  const plan = planContextSeed(entries, files);
  if (!plan.ok) {
    console.error("Manifest errors:");
    for (const error of plan.errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  // The db module opens a pool on import; only load it when we will write.
  const db = dryRun ? null : (await import("@/db")).db;
  const summary = { core: 0, reference: 0, sections: 0, images: 0, imageFailures: 0 };

  for (const doc of plan.documents) {
    const content = await readFile(join(dir, doc.sourceFilename), "utf8");
    const sections = doc.tier === "reference" ? sectionDocument(doc.mimeType, content) : [];
    if (db) {
      const values = {
        title: doc.title,
        description: doc.description,
        kind: doc.kind,
        tier: doc.tier,
        mimeType: doc.mimeType,
        content,
        updatedAt: new Date(),
      } satisfies Partial<typeof studioContextDocuments.$inferInsert>;
      // One transaction per document: a crash must not leave a reference
      // document with its old sections deleted and no new ones written.
      await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(studioContextDocuments)
          .values({ organizationId, sourceFilename: doc.sourceFilename, ...values })
          .onConflictDoUpdate({
            target: [studioContextDocuments.organizationId, studioContextDocuments.sourceFilename],
            set: values,
          })
          .returning({ id: studioContextDocuments.id });
        await tx.delete(studioContextSections).where(eq(studioContextSections.documentId, row.id));
        for (let start = 0; start < sections.length; start += 200) {
          await tx.insert(studioContextSections).values(
            sections.slice(start, start + 200).map((section) => ({ documentId: row.id, ...section })),
          );
        }
      });
    }
    if (doc.tier === "reference") {
      summary.sections += sections.length;
      summary.reference += 1;
    } else {
      summary.core += 1;
    }
    console.log(`document ${doc.tier.padEnd(9)} ${doc.sourceFilename}${doc.tier === "reference" ? ` (${sections.length} sections)` : ""}`);
  }

  for (const image of plan.images) {
    try {
      const bytes = await readFile(join(dir, image.sourceFilename));
      const dimensions = readImageDimensions(new Uint8Array(bytes));
      if (!dimensions) throw new Error("could not read image dimensions");
      if (db) {
        const key = `${blobEnvPrefix}/context/${organizationId}/${image.sourceFilename.replace(/[^a-z0-9._/-]/gi, "_")}`;
        const blob = await putStudioObject(key, new Uint8Array(bytes), contentTypeForKey(key));
        const values = {
          title: image.title,
          description: image.description,
          kind: image.kind,
          imageUrl: blob.url,
          width: dimensions.width,
          height: dimensions.height,
          updatedAt: new Date(),
        } satisfies Partial<typeof studioContextImages.$inferInsert>;
        await db
          .insert(studioContextImages)
          .values({ organizationId, sourceFilename: image.sourceFilename, ...values })
          .onConflictDoUpdate({
            target: [studioContextImages.organizationId, studioContextImages.sourceFilename],
            set: values,
          });
      }
      summary.images += 1;
      console.log(`image    ${image.kind.padEnd(12)} ${image.sourceFilename} (${dimensions.width}x${dimensions.height})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.imageFailures += 1;
      console.warn(`image    FAILED       ${image.sourceFilename}: ${message}`);
    }
  }

  for (const path of plan.skipped) console.warn(`skipped  ${path} (not in manifest)`);
  console.log(
    `\n${dryRun ? "Dry run. " : "Done. "}core=${summary.core} reference=${summary.reference} sections=${summary.sections} images=${summary.images} skipped=${plan.skipped.length} imageFailures=${summary.imageFailures}`,
  );
  // drizzle holds an idle pg client whose socket keeps the loop alive.
  process.exit(summary.imageFailures ? 2 : 0);
}

main(organizationId, dir).catch((error) => {
  console.error(error);
  process.exit(1);
});
