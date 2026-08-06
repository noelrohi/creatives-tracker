import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KlaviyoAccessGate } from "./klaviyo-access-gate";

const access = vi.hoisted(() => ({
  role: "member" as string | null,
  isPending: false,
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: access.replace }),
}));
vi.mock("@/hooks/use-active-organization-role", () => ({
  useActiveOrganizationRole: () => ({
    role: access.role,
    isPending: access.isPending,
  }),
}));

describe("KlaviyoAccessGate", () => {
  beforeEach(() => {
    access.role = "member";
    access.isPending = false;
    access.replace.mockReset();
  });

  it("redirects a member without flashing playground content", async () => {
    render(
      <KlaviyoAccessGate>
        <p>Sensitive evidence</p>
      </KlaviyoAccessGate>,
    );

    expect(screen.queryByText("Sensitive evidence")).toBeNull();
    await waitFor(() => expect(access.replace).toHaveBeenCalledWith("/"));
  });

  it.each(["owner", "admin"])("renders for %s", (role) => {
    access.role = role;
    render(
      <KlaviyoAccessGate>
        <p>Sensitive evidence</p>
      </KlaviyoAccessGate>,
    );
    expect(screen.getByText("Sensitive evidence")).toBeVisible();
  });

  it("shows only a neutral loading state while role is pending", () => {
    access.isPending = true;
    render(
      <KlaviyoAccessGate>
        <p>Sensitive evidence</p>
      </KlaviyoAccessGate>,
    );
    expect(screen.queryByText("Sensitive evidence")).toBeNull();
    expect(access.replace).not.toHaveBeenCalled();
  });
});
