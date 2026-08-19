import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isPrivilegedOrgRole } from "./organization-access";

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
