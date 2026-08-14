import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GoogleAdsLabLink } from "./lab-link";

describe("GoogleAdsLabLink", () => {
  it.each(["owner", "admin"] as const)("shows for %s", (role) => {
    render(<GoogleAdsLabLink role={role} />);
    expect(
      screen.getByRole("link", { name: "Google Ads Lab" }),
    ).toHaveAttribute("href", "/attribution/google-ads");
  });

  it.each(["member", null] as const)("hides for %s", (role) => {
    render(<GoogleAdsLabLink role={role} />);
    expect(screen.queryByRole("link", { name: "Google Ads Lab" })).toBeNull();
  });
});
