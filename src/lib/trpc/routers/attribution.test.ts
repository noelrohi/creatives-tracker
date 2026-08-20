import { describe, expect, it } from "vitest";
import { computeAov } from "./attribution";

describe("computeAov", () => {
  it("rounds average revenue to integer cents and formats it as money", () => {
    expect(computeAov(1_001, 3)).toBe("3.34");
  });

  it("returns null when there are no orders", () => {
    expect(computeAov(0, 0)).toBeNull();
  });
});
