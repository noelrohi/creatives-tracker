import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { featureFlagDefs } from "./feature-flags";
import {
  canAccessMemberPath,
  isPrivilegedOrgRole,
} from "./organization-access";

describe("isPrivilegedOrgRole", () => {
  it.each([
    ["owner", true],
    ["admin", true],
    ["member", false],
    [null, false],
    [undefined, false],
  ] as const)("returns %s for %s", (role, expected) => {
    expect(isPrivilegedOrgRole(role)).toBe(expected);
  });
});

describe.each([
  "src/app/(protected)/(dashboard)/page.tsx",
  "src/app/(protected)/insights/page.tsx",
])("dashboard action access in %s", (pagePath) => {
  it("fails closed until a privileged role is resolved", () => {
    const source = readFileSync(resolve(process.cwd(), pagePath), "utf8");

    expect(source).toContain("const canAct = isPrivilegedOrgRole(role);");
    expect(source).not.toContain('const canAct = role !== "member";');
  });
});

describe("canAccessMemberPath", () => {
  it("lets members reach every flag-gated route the sidebar shows them", () => {
    for (const def of featureFlagDefs) {
      expect(canAccessMemberPath("member", def.href)).toBe(true);
      expect(canAccessMemberPath("member", `${def.href}/detail`)).toBe(true);
    }
  });

  it("lets members reach the base read-only surfaces", () => {
    for (const path of [
      "/",
      "/creatives",
      "/teams",
      "/meta",
      "/mer",
      "/campaigns",
    ]) {
      expect(canAccessMemberPath("member", path)).toBe(true);
    }
  });

  it("keeps privileged surfaces off-limits for members", () => {
    for (const path of ["/import", "/accounts", "/settings", "/settings/api-keys"]) {
      expect(canAccessMemberPath("member", path)).toBe(false);
    }
  });

  it("matches on path boundaries, not raw prefixes", () => {
    expect(canAccessMemberPath("member", "/mercury")).toBe(false);
    expect(canAccessMemberPath("member", "/campaignstats")).toBe(false);
  });

  it("does not restrict owners and admins", () => {
    expect(canAccessMemberPath("owner", "/settings")).toBe(true);
    expect(canAccessMemberPath("admin", "/import")).toBe(true);
  });
});
