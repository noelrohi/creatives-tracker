import { describe, expect, it } from "vitest";
import { planContextSeed } from "./studio-context-manifest";

const files = [
  { path: "other-documents/brand.json", size: 900 },
  { path: "other-documents/testimonials.md", size: 1_100_000 },
  { path: "other-documents/big.pdf", size: 57_000_000 },
  { path: "images/r3.png", size: 200_000 },
  { path: "images/unlisted.jpg", size: 100 },
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
      expect.objectContaining({ file: "other-documents/brand.json", mimeType: "application/json", tier: "core" }),
      expect.objectContaining({ file: "other-documents/testimonials.md", mimeType: "text/markdown", tier: "reference" }),
    ]);
    expect(plan.images).toEqual([expect.objectContaining({ file: "images/r3.png", kind: "product" })]);
    expect(plan.skipped).toEqual(["other-documents/big.pdf", "images/unlisted.jpg"]);
  });

  it("fails on a missing file, a duplicate, a document without a tier, and a wrong kind for the extension", () => {
    const plan = planContextSeed(
      [
        { file: "nope.md", title: "x", description: "y", kind: "other", tier: "core" },
        { file: "images/r3.png", title: "a", description: "b", kind: "product" },
        { file: "images/r3.png", title: "a", description: "b", kind: "product" },
        { file: "other-documents/brand.json", title: "x", description: "y", kind: "guideline" },
        { file: "other-documents/testimonials.md", title: "x", description: "y", kind: "logo" as never },
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

  it("rejects an image entry with a tier or a document kind", () => {
    const plan = planContextSeed(
      [{ file: "images/r3.png", title: "a", description: "b", kind: "guideline" as never, tier: "core" }],
      files,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors).toEqual(["images/r3.png: kind \"guideline\" is not an image kind"]);
  });

  it("rejects a malformed entry before checking files", () => {
    const plan = planContextSeed([{ file: "images/r3.png" } as never], files);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors[0]).toMatch(/^entry 1: /);
  });
});
