import { describe, it, expect } from "vitest";
import { createMockCaller } from "../test-helpers";

/**
 * Tests that member role is blocked from write operations across all
 * data mutation routers (orgWriteProcedure), and that admin/owner pass.
 */

const memberCaller = createMockCaller({ role: "member" });
const adminCaller = createMockCaller({ role: "admin" });
const ownerCaller = createMockCaller({ role: "owner" });

async function expectPassesMiddleware(call: () => Promise<unknown>) {
  try {
    await call();
  } catch (error) {
    expect(error).not.toMatchObject({ code: "FORBIDDEN" });
  }
}

// Helper: assert a call is forbidden for member but not for admin/owner
function describeMutation(
  name: string,
  callMember: () => Promise<unknown>,
  callAdmin: () => Promise<unknown>,
  callOwner: () => Promise<unknown>,
) {
  describe(name, () => {
    it("member is forbidden", async () => {
      await expect(callMember()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("admin passes middleware", async () => {
      await expectPassesMiddleware(callAdmin);
    });

    it("owner passes middleware", async () => {
      await expectPassesMiddleware(callOwner);
    });
  });
}

describe("campaign mutations", () => {
  describeMutation(
    "create",
    () => memberCaller.campaign.create(),
    () => adminCaller.campaign.create(),
    () => ownerCaller.campaign.create(),
  );

  describeMutation(
    "delete",
    () => memberCaller.campaign.delete({ id: "x" }),
    () => adminCaller.campaign.delete({ id: "x" }),
    () => ownerCaller.campaign.delete({ id: "x" }),
  );
});

describe("ad mutations", () => {
  describeMutation(
    "create",
    () => memberCaller.ad.create({ adSetId: "x" }),
    () => adminCaller.ad.create({ adSetId: "x" }),
    () => ownerCaller.ad.create({ adSetId: "x" }),
  );

  describeMutation(
    "delete",
    () => memberCaller.ad.delete({ id: "x" }),
    () => adminCaller.ad.delete({ id: "x" }),
    () => ownerCaller.ad.delete({ id: "x" }),
  );
});

describe("adSet mutations", () => {
  describeMutation(
    "create",
    () => memberCaller.adSet.create({ campaignId: "x" }),
    () => adminCaller.adSet.create({ campaignId: "x" }),
    () => ownerCaller.adSet.create({ campaignId: "x" }),
  );

  describeMutation(
    "delete",
    () => memberCaller.adSet.delete({ id: "x" }),
    () => adminCaller.adSet.delete({ id: "x" }),
    () => ownerCaller.adSet.delete({ id: "x" }),
  );
});

describe("adCreative mutations", () => {
  const TAGGED_CREATIVE = {
    persona: "busy parents",
    angle: "problem_solution",
    awarenessLevel: "problem_aware",
  } as const;

  describeMutation(
    "create",
    // §6.1: a creative cannot be born untagged, so even the access check has
    // to supply the enforced trio.
    () => memberCaller.adCreative.create(TAGGED_CREATIVE),
    () => adminCaller.adCreative.create(TAGGED_CREATIVE),
    () => ownerCaller.adCreative.create(TAGGED_CREATIVE),
  );

  describeMutation(
    "delete",
    () => memberCaller.adCreative.delete({ id: "x" }),
    () => adminCaller.adCreative.delete({ id: "x" }),
    () => ownerCaller.adCreative.delete({ id: "x" }),
  );
});

describe("tag mutations", () => {
  describeMutation(
    "attach",
    () => memberCaller.tag.attach({ entityType: "ad", entityId: "x", tagName: "t" }),
    () => adminCaller.tag.attach({ entityType: "ad", entityId: "x", tagName: "t" }),
    () => ownerCaller.tag.attach({ entityType: "ad", entityId: "x", tagName: "t" }),
  );

  describeMutation(
    "detach",
    () => memberCaller.tag.detach({ entityType: "ad", entityId: "x", tagId: "t" }),
    () => adminCaller.tag.detach({ entityType: "ad", entityId: "x", tagId: "t" }),
    () => ownerCaller.tag.detach({ entityType: "ad", entityId: "x", tagId: "t" }),
  );
});

describe("abTest mutations", () => {
  describeMutation(
    "create",
    () => memberCaller.abTest.create(),
    () => adminCaller.abTest.create(),
    () => ownerCaller.abTest.create(),
  );

  describeMutation(
    "delete",
    () => memberCaller.abTest.delete({ id: "x" }),
    () => adminCaller.abTest.delete({ id: "x" }),
    () => ownerCaller.abTest.delete({ id: "x" }),
  );
});

describe("adAccount mutations", () => {
  describeMutation(
    "create",
    () =>
      memberCaller.adAccount.create({ name: "Test", metaAccountId: "123" }),
    () =>
      adminCaller.adAccount.create({ name: "Test", metaAccountId: "123" }),
    () =>
      ownerCaller.adAccount.create({ name: "Test", metaAccountId: "123" }),
  );

  describeMutation(
    "delete",
    () => memberCaller.adAccount.delete({ id: "x" }),
    () => adminCaller.adAccount.delete({ id: "x" }),
    () => ownerCaller.adAccount.delete({ id: "x" }),
  );
});

describe("adAccount reads", () => {
  it("member can list sanitized accounts", async () => {
    await expectPassesMiddleware(() => memberCaller.adAccount.list());
  });

  it("member is forbidden from getById", async () => {
    await expect(
      memberCaller.adAccount.getById({ id: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("member can read non-admin data", () => {
  it("campaign list passes middleware", async () => {
    await expectPassesMiddleware(() => memberCaller.campaign.list());
  });

  it("ad list passes middleware", async () => {
    await expectPassesMiddleware(() => memberCaller.ad.list());
  });

  it("tag search passes middleware", async () => {
    await expectPassesMiddleware(() => memberCaller.tag.search({ query: "test" }));
  });
});
