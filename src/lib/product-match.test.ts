import { describe, expect, it } from "vitest";
import { buildProductMatchPrompt, pickProductMatch, productMatchSchema } from "./product-match";

const candidates = [
  { imageUrl: "https://blob.test/product.png", label: "brand product photo" },
  { imageUrl: "https://blob.test/r1.png", label: "R1 mouthguard: Hero render" },
];

describe("buildProductMatchPrompt", () => {
  it("numbers the candidates from 1 and asks for the same model, colour, and markings", () => {
    const prompt = buildProductMatchPrompt("Reviv", candidates);
    expect(prompt).toContain("Image 1 is a crop of the product from the source ad");
    expect(prompt).toContain("Image 2: brand product photo");
    expect(prompt).toContain("Image 3: R1 mouthguard: Hero render");
    expect(prompt).toContain("same model, colour, and markings");
    expect(prompt).toContain("Reviv");
  });
});

describe("pickProductMatch", () => {
  it("returns the candidate at the 1-based index when confident", () => {
    expect(pickProductMatch({ match: 2, confidence: 0.9, note: "" }, candidates)).toEqual(candidates[1]);
  });
  it("returns null below the confidence floor, for null, and for an out-of-range index", () => {
    expect(pickProductMatch({ match: 1, confidence: 0.5, note: "" }, candidates)).toBeNull();
    expect(pickProductMatch({ match: null, confidence: 1, note: "" }, candidates)).toBeNull();
    expect(pickProductMatch({ match: 3, confidence: 1, note: "" }, candidates)).toBeNull();
  });
  it("validates the model's answer shape", () => {
    expect(productMatchSchema.safeParse({ match: null, confidence: 0.2, note: "none" }).success).toBe(true);
    expect(productMatchSchema.safeParse({ match: 0, confidence: 0.2, note: "" }).success).toBe(false);
  });
});
