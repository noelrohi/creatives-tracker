import { describe, expect, it } from "vitest";
import { planContextSeed } from "./studio-context-manifest";

const files = [
  { path: "other-documents/brand.json" },
  { path: "other-documents/testimonials.md" },
  { path: "other-documents/big.pdf" },
  { path: "images/r3.png" },
  { path: "images/unlisted.jpg" },
];

describe("planContextSeed", () => {
  it("splits manifest entries into documents and images and reports skips", () => {
    const plan = planContextSeed(
      [
        { file: "other-documents/brand.json", title: "Brand guideline", description: "Palette and fonts", kind: "guideline", tier: "core" },
        { file: "other-documents/testimonials.md", title: "Testimonials", description: "By angle", kind: "testimonials", tier: "reference" },
        { file: "images/r3.png", title: "R3 mouthguard", description: "Hero render", kind: "product" },
      ],
      files,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.documents).toEqual([
      expect.objectContaining({ sourceFilename: "other-documents/brand.json", mimeType: "application/json", tier: "core" }),
      expect.objectContaining({ sourceFilename: "other-documents/testimonials.md", mimeType: "text/markdown", tier: "reference" }),
    ]);
    expect(plan.images).toEqual([expect.objectContaining({ sourceFilename: "images/r3.png", kind: "product" })]);
    expect(plan.skipped).toEqual(["other-documents/big.pdf", "images/unlisted.jpg"]);
  });

  it("names the field and entry file in schema errors", () => {
    const plan = planContextSeed(
      [{ file: "images/r3.png", kind: "product", description: "" }],
      files,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors[0]).toContain("title");
    expect(plan.errors[0]).toContain("description");
    expect(plan.errors[0].startsWith("entry 1 (images/r3.png): ")).toBe(true);
  });

  it("fails on a missing file, a duplicate, a document without a tier, and a wrong kind for the extension", () => {
    const plan = planContextSeed(
      [
        { file: "nope.md", title: "x", description: "y", kind: "other", tier: "core" },
        { file: "images/r3.png", title: "a", description: "b", kind: "product" },
        { file: "images/r3.png", title: "a", description: "b", kind: "product" },
        { file: "other-documents/brand.json", title: "x", description: "y", kind: "guideline" },
        { file: "other-documents/testimonials.md", title: "x", description: "y", kind: "logo" },
      ],
      files,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors).toEqual([
      "nope.md: file not found",
      "images/r3.png: listed more than once",
      "other-documents/brand.json: documents need a tier (core or reference)",
      "other-documents/testimonials.md: kind \"logo\" is not a document kind",
    ]);
  });

  it("rejects an image entry with a document kind", () => {
    const plan = planContextSeed(
      [{ file: "images/r3.png", title: "a", description: "b", kind: "guideline" }],
      files,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors).toEqual(["images/r3.png: kind \"guideline\" is not an image kind"]);
  });

  it("rejects an image entry with a tier", () => {
    const plan = planContextSeed(
      [{ file: "images/r3.png", title: "a", description: "b", kind: "product", tier: "core" }],
      files,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors).toEqual(["images/r3.png: images do not take a tier"]);
  });

  it("rejects a malformed entry before checking files", () => {
    const plan = planContextSeed([{ file: "images/r3.png" }], files);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors[0]).toMatch(/^entry 1 \(images\/r3\.png\): /);
  });

  it("normalizes slashes and relative prefixes so paths match the scanned files", () => {
    const dotSlash = planContextSeed(
      [{ file: "./images/r3.png", title: "a", description: "b", kind: "product" }],
      files,
    );
    expect(dotSlash.ok).toBe(true);
    if (dotSlash.ok) expect(dotSlash.images[0].sourceFilename).toBe("images/r3.png");

    const backslash = planContextSeed(
      [{ file: "images\\r3.png", title: "a", description: "b", kind: "product" }],
      files,
    );
    expect(backslash.ok).toBe(true);
    if (backslash.ok) expect(backslash.images[0].sourceFilename).toBe("images/r3.png");
  });

  it("hints at a case-only mismatch when a file is not found", () => {
    const plan = planContextSeed(
      [{ file: "Images/R3.PNG", title: "a", description: "b", kind: "product" }],
      files,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors).toEqual(['Images/R3.PNG: file not found (did you mean "images/r3.png"?)']);
  });

  it("reports unsupported file type", () => {
    const plan = planContextSeed(
      [{ file: "other-documents/big.pdf", title: "x", description: "y", kind: "other", tier: "core" }],
      files,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors).toEqual(["other-documents/big.pdf: unsupported file type .pdf"]);
  });
});
