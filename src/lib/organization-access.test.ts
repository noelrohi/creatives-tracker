import { describe, expect, it } from "vitest";
import { featureFlagDefs } from "./feature-flags";
import { canAccessMemberPath } from "./organization-access";

describe("canAccessMemberPath", () => {
  it("lets members reach every flag-gated route the sidebar shows them", () => {
    for (const def of featureFlagDefs) {
      expect(canAccessMemberPath("member", def.href)).toBe(true);
      expect(canAccessMemberPath("member", `${def.href}/detail`)).toBe(true);
    }
  });

  it("lets members reach the base read-only surfaces", () => {
    for (const path of ["/", "/creatives", "/teams", "/mer", "/campaigns"]) {
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
