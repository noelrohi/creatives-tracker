import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  createMockCaller,
  createUnauthenticatedCaller,
} from "../test-helpers";

describe("apiKey router RBAC", () => {
  const memberCaller = createMockCaller({ role: "member" });
  const adminCaller = createMockCaller({ role: "admin" });
  const ownerCaller = createMockCaller({ role: "owner" });
  const unauthCaller = createUnauthenticatedCaller();

  describe("member is forbidden", () => {
    it("list", async () => {
      await expect(memberCaller.apiKey.list()).rejects.toThrow(TRPCError);
      await expect(memberCaller.apiKey.list()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("create", async () => {
      await expect(
        memberCaller.apiKey.create({ name: "test", scopes: ["*"] }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("revoke", async () => {
      await expect(
        memberCaller.apiKey.revoke({ id: "key-1" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("delete", async () => {
      await expect(
        memberCaller.apiKey.delete({ id: "key-1" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("unauthenticated is forbidden", () => {
    it("list", async () => {
      await expect(unauthCaller.apiKey.list()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });
  });

  // Resolves when a database is reachable, rejects at the DB layer when not —
  // either way, anything but FORBIDDEN proves the RBAC middleware passed.
  async function expectPastAuthorization(call: Promise<unknown>) {
    const rejection = await call.then(
      () => null,
      (error: unknown) => error,
    );
    if (rejection !== null) {
      expect(rejection).not.toMatchObject({ code: "FORBIDDEN" });
    }
  }

  describe("admin passes middleware", () => {
    it("list proceeds past authorization", async () => {
      await expectPastAuthorization(adminCaller.apiKey.list());
    });
  });

  describe("owner passes middleware", () => {
    it("list proceeds past authorization", async () => {
      await expectPastAuthorization(ownerCaller.apiKey.list());
    });
  });
});
