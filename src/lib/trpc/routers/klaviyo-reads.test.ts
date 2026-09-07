import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), read: vi.fn() }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/api-keys", async (original) => ({ ...await original<typeof import("@/lib/api-keys")>(), authenticateApiKey: mocks.authenticate }));
vi.mock("@/lib/klaviyo/snapshot-reads", () => ({ readSnapshot: mocks.read }));
import { callOpenApiProcedure, generateOpenApiDocument } from "../openapi";
import { appRouter } from "./_app";
const names = ["campaigns", "metrics", "events", "campaignValues"] as const;
const window = { since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00Z" };
function request(name: string, token: string, params = new URLSearchParams()) {
  return callOpenApiProcedure(new Request(`https://adsolute.test/api/openapi/klaviyoReads/${name}?${params}`, {
    headers: { authorization: `Bearer ${token}`, "x-adsolute-organization-id": "forged" },
  }), "klaviyoReads", name);
}
beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue({ state: "not_available", dataset: "metrics", reason: "not_synced", message: "Not synced", requiredSyncRequest: { dataset: "metrics" } });
  mocks.authenticate.mockReset().mockImplementation(async (token) => token === "invalid" ? null : ({ apiKeyId: "key", organizationId: "org", scopes: [token === "ask_write" ? "write" : "read"] }));
});
describe("Klaviyo snapshot OpenAPI authorization and declaration", () => {
  it("keeps the snapshot service runtime import graph free of provider, credentials and Trigger", () => {
    const visited = new Set<string>();
    function visit(file: string) {
      if (visited.has(file)) return;
      visited.add(file);
      const source = ts.transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        expect(specifier).not.toMatch(/credential-provider|read-transport|collection-reads|campaign-value-reads|source-store|@trigger|snapshot-collector|snapshot-dispatch/);
        if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
        const resolved = specifier.startsWith("@/") ? path.resolve("src", specifier.slice(2)) : path.resolve(path.dirname(file), specifier);
        let dependency = `${resolved}.ts`;
        try { readFileSync(dependency); } catch { dependency = path.join(resolved, "index.ts"); }
        visit(dependency);
      }
    }
    visit(path.resolve("src/lib/klaviyo/snapshot-reads.ts"));
    expect(visited.size).toBeGreaterThan(3);
  });
  it.each(names)("authenticates and requires read scope before %s DB work", async (name) => {
    expect((await request(name, "invalid")).status).toBe(401);
    expect((await request(name, "ask_write")).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("uses the authenticated organization, not forged headers", async () => {
    expect((await request("metrics", "ask_read")).status).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith("org", { dataset: "metrics" });
  });
  it.each([
    { ...window, metricIds: "M1,M1" }, { ...window, metricIds: "M1", organizationId: "other" },
    { ...window, metricIds: "M1", privateApiKey: "synthetic" }, { ...window, metricIds: "M1", since: "invalid" },
  ])("rejects malformed or undeclared inputs", async (params) => {
    expect((await request("events", "ask_read", new URLSearchParams(params))).status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("does not expose administrator controls to API keys", async () => {
    const caller = appRouter.createCaller({ principalType: "apiKey", session: null, userId: null, organizationId: "org", orgRole: null, apiKeyId: "key", apiKeyScopes: ["*"] });
    await expect(caller.klaviyo.uninstall()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.klaviyoSnapshots.status()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.klaviyoSnapshots.refresh({ dataset: "metrics" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.klaviyoSnapshots.configure({ dataset: "metrics", dailyEnabled: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const document = generateOpenApiDocument("https://adsolute.test");
    expect(Object.keys(document.paths).some((path) => path.includes("/klaviyoSnapshots/"))).toBe(false);
  });
  it("documents four typed DB reads with history, continuation and array encoding", () => {
    const document = generateOpenApiDocument("https://adsolute.test");
    for (const name of names) {
      const path = document.paths[`/api/openapi/klaviyoReads/${name}`];
      expect(Object.keys(path)).toEqual(["get"]);
      expect(path.get).toMatchObject({ security: [{ bearerAuth: [] }, { sessionCookie: [] }], parameters: expect.arrayContaining([
        expect.objectContaining({ name: "snapshotId", required: false }), expect.objectContaining({ name: "continuation", required: false }),
      ]) });
      expect(JSON.stringify(path.get)).toContain("not_available");
    }
    expect(document.paths["/api/openapi/klaviyoReads/events"].get).toMatchObject({ parameters: expect.arrayContaining([
      expect.objectContaining({ name: "metricIds", style: "form", explode: true }),
    ]) });
  });
});
