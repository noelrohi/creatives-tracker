import { describe, expect, it } from "vitest";
import {
  buildClaimsConstraint,
  scanTextForClaims,
} from "./studio-claims";

describe("scanTextForClaims", () => {
  it("finds a prohibited claim and reports its normalized-text index", () => {
    expect(
      scanTextForClaims("Try our clinically proven formula today.", [
        "clinically proven",
      ]),
    ).toEqual([{ claim: "clinically proven", index: 8 }]);
  });

  it("returns no match when the claim is absent", () => {
    expect(scanTextForClaims("Supports your everyday routine.", ["cures pain"])).toEqual(
      [],
    );
  });

  it("matches claims case-insensitively", () => {
    expect(scanTextForClaims("This Formula CURES PAIN fast.", ["cures pain"])).toEqual([
      { claim: "cures pain", index: 13 },
    ]);
  });

  it("normalizes punctuation, whitespace, and dashes", () => {
    expect(scanTextForClaims("Our formula is FDA approved!", ["fda-approved"])).toEqual([
      { claim: "fda-approved", index: 15 },
    ]);
  });

  it("attributes multiple matches to their original claims", () => {
    expect(
      scanTextForClaims("FDA approved and guaranteed results.", [
        "guaranteed results",
        "FDA-approved",
        "not present",
      ]),
    ).toEqual([
      { claim: "guaranteed results", index: 17 },
      { claim: "FDA-approved", index: 0 },
    ]);
  });

  it("ignores blank claims and an empty claims list", () => {
    expect(scanTextForClaims("Any text", ["", "   "])).toEqual([]);
    expect(scanTextForClaims("Any text", [])).toEqual([]);
  });
});

describe("buildClaimsConstraint", () => {
  it("returns an empty block when both lists are empty", () => {
    expect(
      buildClaimsConstraint({ prohibitedClaims: [], requiredDisclaimers: [] }),
    ).toBe("");
  });

  it("builds a hard-constraint block for claims and disclaimers", () => {
    expect(
      buildClaimsConstraint({
        prohibitedClaims: ["Cures chronic pain", "FDA approved"],
        requiredDisclaimers: ["Results vary by person"],
      }),
    ).toBe(
      [
        "CLAIMS GUARDRAIL (hard constraints):",
        "- Never state or imply: Cures chronic pain",
        "- Never state or imply: FDA approved",
        "- Required disclaimers that must accompany relevant claims: Results vary by person",
        "Follow these constraints exactly in every concept and line of copy.",
      ].join("\n"),
    );
  });
});
