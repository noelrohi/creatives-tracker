import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("server-only", () => ({}));

const { createCallerFactory, orgProcedure, orgWriteProcedure, router } =
  await import("../init");

const scopeRouter = router({
  read: orgProcedure.query(() => ({ ok: true })),
  write: orgWriteProcedure.mutation(() => ({ ok: true })),
});

const createCaller = createCallerFactory(scopeRouter);

function createApiKeyCaller(scopes: string[]) {
  return createCaller({
    session: null,
    principalType: "apiKey" as const,
    userId: null,
    organizationId: "test-org-id",
    orgRole: null,
    apiKeyId: "test-api-key-id",
    apiKeyScopes: scopes,
  });
}

function createSessionCaller() {
  return createCaller({
    session: {
      user: { id: "test-user-id" },
      session: {
        id: "test-session-id",
        activeOrganizationId: "test-org-id",
      },
    } as never,
    principalType: "session" as const,
    userId: "test-user-id",
    organizationId: "test-org-id",
    orgRole: "admin",
    apiKeyId: null,
    apiKeyScopes: ["unrelated"],
  });
}

describe("API key procedure scopes", () => {
  it("allows a read-scoped key through read procedures and rejects writes", async () => {
    const caller = createApiKeyCaller(["read"]);

    await expect(caller.read()).resolves.toEqual({ ok: true });
    await expect(caller.write()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("write"),
    });
  });

  it("allows a write-scoped key through write procedures and rejects reads", async () => {
    const caller = createApiKeyCaller(["write"]);

    await expect(caller.write()).resolves.toEqual({ ok: true });
    await expect(caller.read()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("read"),
    });
  });

  it.each([
    ["wildcard", ["*"]],
    ["legacy empty scopes", []],
  ])("allows a %s key through both procedure tiers", async (_name, scopes) => {
    const caller = createApiKeyCaller(scopes);

    await expect(caller.read()).resolves.toEqual({ ok: true });
    await expect(caller.write()).resolves.toEqual({ ok: true });
  });

  it("does not apply API key scopes to session principals", async () => {
    const caller = createSessionCaller();

    await expect(caller.read()).resolves.toEqual({ ok: true });
    await expect(caller.write()).resolves.toEqual({ ok: true });
  });
});
