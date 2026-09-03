import { describe, expect, it } from "vitest";
import {
  SECTION_MAX_CHARS,
  sectionJson,
  sectionMarkdown,
  sectionDocument,
} from "./studio-context-sections";

describe("sectionMarkdown", () => {
  it("splits on headings and builds the heading chain as the path", () => {
    const md = [
      "# Testimonials",
      "intro line",
      "## Athletic Performance",
      "### Unknown 13",
      "body one",
      "### Unknown 14",
      "body two",
      "## Sleep",
      "body three",
    ].join("\n");
    const sections = sectionMarkdown(md);
    expect(sections.map((s) => s.path)).toEqual([
      "Testimonials",
      "Testimonials > Athletic Performance > Unknown 13",
      "Testimonials > Athletic Performance > Unknown 14",
      "Testimonials > Sleep",
    ]);
    expect(sections[1]).toMatchObject({ heading: "Unknown 13", content: "body one" });
    expect(sections.map((s) => s.ordinal)).toEqual([0, 1, 2, 3]);
  });

  it("drops heading-only sections with no body", () => {
    const sections = sectionMarkdown("## A\n## B\ntext");
    expect(sections.map((s) => s.path)).toEqual(["B"]);
  });

  it("splits oversized bodies into parts with a suffix", () => {
    const body = "x".repeat(SECTION_MAX_CHARS * 2 + 10);
    const sections = sectionMarkdown(`## Big\n${body}`);
    expect(sections.map((s) => s.path)).toEqual([
      "Big (part 1)",
      "Big (part 2)",
      "Big (part 3)",
    ]);
    expect(sections[0].content).toHaveLength(SECTION_MAX_CHARS);
    expect(sections[2].content).toHaveLength(10);
  });
});

describe("sectionJson", () => {
  it("uses top-level keys for objects", () => {
    const sections = sectionJson(JSON.stringify({ a: { x: 1 }, b: [1, 2] }));
    expect(sections.map((s) => s.path)).toEqual(["a", "b"]);
    expect(JSON.parse(sections[0].content)).toEqual({ x: 1 });
  });

  it("uses one section per page for a pages export", () => {
    const sections = sectionJson(
      JSON.stringify({ file_name: "t.pdf", pages: [{ page: 1, text: "one" }, { page: 2, text: "two" }] }),
    );
    expect(sections.map((s) => s.path)).toEqual(["Page 1", "Page 2"]);
    expect(sections[1].content).toBe("two");
  });

  it("uses array indexes for a top-level array", () => {
    const sections = sectionJson(JSON.stringify([{ name: "first" }, { name: "second" }]));
    expect(sections.map((s) => s.path)).toEqual(["Item 1", "Item 2"]);
  });

  it("falls back to a single section on invalid JSON", () => {
    const sections = sectionJson("not json");
    expect(sections).toEqual([{ ordinal: 0, heading: "Document", path: "Document", content: "not json" }]);
  });
});

describe("sectionDocument", () => {
  it("routes by mime type", () => {
    expect(sectionDocument("application/json", "[1]")[0].path).toBe("Item 1");
    expect(sectionDocument("text/markdown", "## H\nb")[0].path).toBe("H");
    expect(sectionDocument("text/plain", "plain")[0].path).toBe("Document");
  });
});
