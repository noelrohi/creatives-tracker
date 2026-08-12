import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  createMockCaller,
  createUnauthenticatedCaller,
} from "../test-helpers";

describe("organization router RBAC", () => {
  const orgId = "test-org-id";
  const memberCaller = createMockCaller({ role: "member" });
  const adminCaller = createMockCaller({ role: "admin" });
  const ownerCaller = createMockCaller({ role: "owner" });
  const unauthCaller = createUnauthenticatedCaller();

  describe("delete requires owner", () => {
    it("member is forbidden", async () => {
      await expect(
        memberCaller.organization.delete({ organizationId: orgId }),
      ).rejects.toThrow(TRPCError);
      await expect(
        memberCaller.organization.delete({ organizationId: orgId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("admin is forbidden", async () => {
      await expect(
        adminCaller.organization.delete({ organizationId: orgId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("unauthenticated is forbidden", async () => {
      await expect(
        unauthCaller.organization.delete({ organizationId: orgId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("owner passes middleware", async () => {
      // Rejects at the DB/auth layer (org does not exist), never FORBIDDEN —
      // settle manually so a reachable database cannot break the assertion.
      const rejection = await ownerCaller.organization
        .delete({ organizationId: orgId })
        .then(
          () => null,
          (error: unknown) => error,
        );
      if (rejection !== null) {
        expect(rejection).not.toMatchObject({ code: "FORBIDDEN" });
      }
    });

    it("owner cannot delete a different organization", async () => {
      await expect(
        ownerCaller.organization.delete({ organizationId: "other-org-id" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });
});
