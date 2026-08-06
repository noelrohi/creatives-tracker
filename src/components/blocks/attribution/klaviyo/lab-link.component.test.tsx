import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KlaviyoLabLink } from "./lab-link";

describe("KlaviyoLabLink", () => {
  it.each(["owner", "admin"] as const)("shows for %s", (role) => {
    render(<KlaviyoLabLink role={role} />);
    expect(screen.getByRole("link", { name: "Klaviyo Lab" })).toHaveAttribute(
      "href",
      "/attribution/klaviyo",
    );
  });

  it.each(["member", null] as const)("hides for %s", (role) => {
    render(<KlaviyoLabLink role={role} />);
    expect(screen.queryByRole("link", { name: "Klaviyo Lab" })).toBeNull();
  });
});
