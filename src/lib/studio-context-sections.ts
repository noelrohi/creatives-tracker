export const SECTION_MAX_CHARS = 8_000;

export type ContextSection = {
  ordinal: number;
  heading: string;
  path: string;
  content: string;
};

type RawSection = { heading: string; path: string; content: string };

// Keys with no content get no section.
function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim().length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function finalizeSections(sections: RawSection[]): ContextSection[] {
  const out: ContextSection[] = [];
  for (const section of sections) {
    const content = section.content.trim();
    if (!content) continue;
    if (content.length <= SECTION_MAX_CHARS) {
      out.push({ ordinal: out.length, ...section, content });
      continue;
    }
    const partCount = Math.ceil(content.length / SECTION_MAX_CHARS);
    for (let part = 0; part < partCount; part += 1) {
      out.push({
        ordinal: out.length,
        heading: section.heading,
        path: `${section.path} (part ${part + 1})`,
        content: content.slice(part * SECTION_MAX_CHARS, (part + 1) * SECTION_MAX_CHARS),
      });
    }
  }
  return out;
}

export function sectionMarkdown(markdown: string): ContextSection[] {
  const chain: string[] = [];
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) {
      if (current) current.content += (current.content ? "\n" : "") + line;
      else if (line.trim()) {
        current = { heading: "Document", path: "Document", content: line };
      }
      continue;
    }
    if (current) sections.push(current);
    const level = match[1].length;
    const heading = match[2].trim();
    // Skipped heading levels leave holes in the chain; filter(Boolean) drops them.
    chain.length = level - 1;
    chain.push(heading);
    const path = chain.filter(Boolean).join(" > ");
    current = { heading, path, content: "" };
  }
  if (current) sections.push(current);
  return finalizeSections(sections);
}

function stringify(value: unknown) {
  // Indent 1 keeps nested JSON readable while spending few tokens.
  return typeof value === "string" ? value : JSON.stringify(value, null, 1);
}

export function sectionJson(json: string): ContextSection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return finalizeSections([{ heading: "Document", path: "Document", content: json }]);
  }
  if (Array.isArray(parsed)) {
    return finalizeSections(
      parsed.map((item, index) => ({
        heading: `Item ${index + 1}`,
        path: `Item ${index + 1}`,
        content: stringify(item),
      })),
    );
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const pages = record.pages;
    if (Array.isArray(pages) && pages.length > 0 && pages.some((p) => p && typeof p === "object" && "text" in p)) {
      return finalizeSections(
        (pages as Array<{ page?: number; text?: unknown }>).map((page, index) => {
          const label = `Page ${page.page ?? index + 1}`;
          return { heading: label, path: label, content: stringify(page.text ?? page) };
        }),
      );
    }
    return finalizeSections(
      Object.entries(record)
        .filter(([, value]) => !isEmptyValue(value))
        .map(([key, value]) => ({
          heading: key,
          path: key,
          content: stringify(value),
        })),
    );
  }
  return finalizeSections([{ heading: "Document", path: "Document", content: json }]);
}

export function sectionDocument(mimeType: string, content: string): ContextSection[] {
  if (mimeType === "application/json") return sectionJson(content);
  if (mimeType === "text/markdown") return sectionMarkdown(content);
  return finalizeSections([{ heading: "Document", path: "Document", content }]);
}
