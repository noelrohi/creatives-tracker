import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { SourceActionLink } from "./source-links";

function link(bucket: AttributionBucket, role: string | null) {
  return render(<SourceActionLink bucket={bucket} role={role} />);
}

describe("SourceActionLink", () => {
  it.each(["owner", "admin", "member", null] as const)(
    "meta: shows the dashboard link for %s",
    (role) => {
      link("meta", role);
      expect(
        screen.getByRole("link", { name: "Meta dashboard" }),
      ).toHaveAttribute("href", "/meta");
    },
  );

  it.each(["owner", "admin"] as const)(
    "google + klaviyo: labs show for %s",
    (role) => {
      link("google", role);
      link("klaviyo", role);
      expect(
        screen.getByRole("link", { name: "Google Ads Lab" }),
      ).toHaveAttribute("href", "/attribution/google-ads");
      expect(
        screen.getByRole("link", { name: "Klaviyo Lab" }),
      ).toHaveAttribute("href", "/attribution/klaviyo");
    },
  );

  it.each(["member", null] as const)("labs hide for %s", (role) => {
    link("google", role);
    link("klaviyo", role);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("buckets without a screen render nothing", () => {
    const { container } = link("tiktok", "owner");
    expect(container).toBeEmptyDOMElement();
  });
});
