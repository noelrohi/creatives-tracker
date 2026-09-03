// Loaders for the org's Studio context library. Core documents are returned
// with full content, since they're inlined into every agent run. Reference
// documents come back as an index of section ids and paths only — the agent
// reads a section's content on demand via readStudioContextSection, which is
// org-scoped through the join so a section id from another org returns null.

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  studioContextDocuments,
  studioContextImages,
  studioContextSections,
  type StudioContextDocumentKind,
  type StudioContextImageKind,
} from "@/schema/studio";

export type CoreContextDocument = {
  id: string;
  title: string;
  kind: StudioContextDocumentKind;
  content: string;
};

export type ReferenceContextDocument = {
  id: string;
  title: string;
  description: string;
  kind: StudioContextDocumentKind;
  sections: { id: string; path: string }[];
};

export type ContextImage = {
  id: string;
  title: string;
  description: string;
  kind: StudioContextImageKind;
  imageUrl: string;
};

export type StudioContextLibrary = {
  core: CoreContextDocument[];
  reference: ReferenceContextDocument[];
  images: ContextImage[];
};

export async function loadStudioContextLibrary(
  organizationId: string,
): Promise<StudioContextLibrary> {
  const [documents, images] = await Promise.all([
    db
      .select({
        id: studioContextDocuments.id,
        title: studioContextDocuments.title,
        description: studioContextDocuments.description,
        kind: studioContextDocuments.kind,
        tier: studioContextDocuments.tier,
        content: studioContextDocuments.content,
      })
      .from(studioContextDocuments)
      .where(eq(studioContextDocuments.organizationId, organizationId))
      .orderBy(asc(studioContextDocuments.title)),
    db
      .select({
        id: studioContextImages.id,
        title: studioContextImages.title,
        description: studioContextImages.description,
        kind: studioContextImages.kind,
        imageUrl: studioContextImages.imageUrl,
      })
      .from(studioContextImages)
      .where(eq(studioContextImages.organizationId, organizationId))
      .orderBy(asc(studioContextImages.title)),
  ]);
  const referenceIds = documents
    .filter((d) => d.tier === "reference")
    .map((d) => d.id);
  const sections = referenceIds.length
    ? await db
        .select({
          id: studioContextSections.id,
          documentId: studioContextSections.documentId,
          path: studioContextSections.path,
        })
        .from(studioContextSections)
        .where(inArray(studioContextSections.documentId, referenceIds))
        .orderBy(
          asc(studioContextSections.documentId),
          asc(studioContextSections.ordinal),
        )
    : [];
  const sectionsByDocument = new Map<string, { id: string; path: string }[]>();
  for (const section of sections) {
    const list = sectionsByDocument.get(section.documentId) ?? [];
    list.push({ id: section.id, path: section.path });
    sectionsByDocument.set(section.documentId, list);
  }
  return {
    core: documents
      .filter((d) => d.tier === "core")
      .map(({ id, title, kind, content }) => ({ id, title, kind, content })),
    reference: documents
      .filter((d) => d.tier === "reference")
      .map(({ id, title, description, kind }) => ({
        id,
        title,
        description,
        kind,
        sections: sectionsByDocument.get(id) ?? [],
      })),
    images,
  };
}

export async function readStudioContextSection(
  organizationId: string,
  documentId: string,
  sectionId: string,
): Promise<{ path: string; content: string } | null> {
  const [row] = await db
    .select({
      path: studioContextSections.path,
      content: studioContextSections.content,
    })
    .from(studioContextSections)
    .innerJoin(
      studioContextDocuments,
      eq(studioContextDocuments.id, studioContextSections.documentId),
    )
    .where(
      and(
        eq(studioContextSections.id, sectionId),
        eq(studioContextSections.documentId, documentId),
        eq(studioContextDocuments.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}
