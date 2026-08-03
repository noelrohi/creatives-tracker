import { describe, expect, it } from "vitest";
import {
  FINGERPRINT_MAX_KEYS,
  REDACTED_PROPERTY_MAX_BYTES,
  REDACTED_PROPERTY_MAX_KEYS,
  redactEventProperties,
} from "@/lib/klaviyo/redaction";

describe("redactEventProperties", () => {
  it("retains approved values and hashes every unknown key", () => {
    const result = redactEventProperties(
      {
        ProductID: "product-1",
        email_address_for_debug: "user@example.com",
        ordinaryLookingUnknownKey: "secret-value",
      },
      new Set(["ProductID"]),
      new Set(["reviv.example.com"]),
    );
    expect(result.values).toEqual({ ProductID: "product-1" });
    expect(result.fingerprint).toEqual(
      expect.arrayContaining([
        { key: "ProductID", keyKind: "approved", type: "string" },
        expect.objectContaining({ keyKind: "sha256", type: "string" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("email_address_for_debug");
    expect(JSON.stringify(result)).not.toContain("user@example.com");
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("keeps only an allowlisted HTTPS host and redacted path", () => {
    const result = redactEventProperties(
      {
        URL: "https://reviv.example.com/account/user@example.com?token=secret#fragment",
      },
      new Set(["URL"]),
      new Set(["reviv.example.com"]),
    );
    expect(result.values.URL).toBe(
      "https://reviv.example.com/account/[redacted]",
    );
  });

  it("redacts repeated sensitive path segments without stateful regex skips", () => {
    const result = redactEventProperties(
      {
        URL: "https://reviv.example.com/user@example.com/other@example.com",
        PagePath: "/orders/abcdefghijklmnopqrstuvwxyz0123456789?token=secret#x",
      },
      new Set(["URL", "PagePath"]),
      new Set(["reviv.example.com"]),
    );
    expect(result.values.URL).toBe(
      "https://reviv.example.com/[redacted]/[redacted]",
    );
    expect(result.values.PagePath).toBe("/orders/[redacted]");
    expect(JSON.stringify(result.values)).not.toContain("token");
  });

  it("redacts IDs after identity path labels but keeps benign product paths", () => {
    const result = redactEventProperties(
      {
        ProfileUrl: "https://reviv.example.com/profiles/12345",
        CustomerUrl: "https://reviv.example.com/customer/abc123",
        ProductUrl: "https://reviv.example.com/products/summer-dress",
      },
      new Set(["ProfileUrl", "CustomerUrl", "ProductUrl"]),
      new Set(["reviv.example.com"]),
    );
    expect(result.values.ProfileUrl).toBe(
      "https://reviv.example.com/profiles/[redacted]",
    );
    expect(result.values.CustomerUrl).toBe(
      "https://reviv.example.com/customer/[redacted]",
    );
    expect(result.values.ProductUrl).toBe(
      "https://reviv.example.com/products/summer-dress",
    );
    expect(JSON.stringify(result.values)).not.toContain("12345");
    expect(JSON.stringify(result.values)).not.toContain("abc123");
  });

  it("fails closed around encoded separators, traversal, credentials, and controls", () => {
    const result = redactEventProperties(
      {
        EncodedSlash: "https://reviv.example.com/products/safe%2fsecret",
        EncodedBackslash: "https://reviv.example.com/products/safe%255csecret",
        Traversal: "https://reviv.example.com/customers/secret/../public",
        Credentials: "https://user:password@reviv.example.com/products/safe",
        Backslash: "https://reviv.example.com/products\\secret",
        Control: "https://reviv.example.com/products/safe\nsecret",
        InvalidEncoding: "https://reviv.example.com/products/%ZZsecret",
        WrongHost: "https://sub.reviv.example.com/products/safe",
        QueryAndFragment:
          "https://reviv.example.com/products/safe?token=secret#fragment",
      },
      new Set([
        "EncodedSlash",
        "EncodedBackslash",
        "Traversal",
        "Credentials",
        "Backslash",
        "Control",
        "InvalidEncoding",
        "WrongHost",
        "QueryAndFragment",
      ]),
      new Set(["reviv.example.com"]),
    );

    expect(result.values).toEqual({
      EncodedBackslash: "https://reviv.example.com/products/[redacted]",
      EncodedSlash: "https://reviv.example.com/products/[redacted]",
      InvalidEncoding: "https://reviv.example.com/products/[redacted]",
      QueryAndFragment: "https://reviv.example.com/products/safe",
    });
    expect(JSON.stringify(Object.values(result.values))).not.toMatch(
      /secret|password|token|fragment|%2f|%255c|%ZZ/i,
    );
  });

  it("handles empty, repeated, and encoded identity labels conservatively", () => {
    const result = redactEventProperties(
      {
        PagePath: "/%70rofiles//abc/users/users/final/products/summer-dress",
      },
      new Set(["PagePath"]),
      new Set(["reviv.example.com"]),
    );

    expect(result.values.PagePath).toBe(
      "/profiles//[redacted]/users/[redacted]/[redacted]/products/summer-dress",
    );
    expect(JSON.stringify(result.values)).not.toMatch(/abc|final/);
  });

  it("removes repeated email and phone text from approved scalars", () => {
    const result = redactEventProperties(
      {
        ProductName:
          "Call +1 (415) 555-2671 or first@example.com / second@example.com",
      },
      new Set(["ProductName"]),
      new Set<string>(),
    );

    expect(result.values.ProductName).toBe(
      "Call [redacted] or [redacted] / [redacted]",
    );
    expect(JSON.stringify(result)).not.toMatch(/415|example\.com/);
  });

  it("enforces value, fingerprint, and byte bounds deterministically", () => {
    const properties = Object.fromEntries(
      Array.from({ length: FINGERPRINT_MAX_KEYS + 8 }, (_, index) => [
        `unknown-secret-key-${String(index).padStart(3, "0")}`,
        `unknown-secret-value-${index}`,
      ]),
    );
    for (let index = 0; index < REDACTED_PROPERTY_MAX_KEYS + 8; index += 1) {
      properties[`Approved${String(index).padStart(3, "0")}`] = "界".repeat(512);
    }
    const approved = new Set(
      Array.from(
        { length: REDACTED_PROPERTY_MAX_KEYS + 8 },
        (_, index) => `Approved${String(index).padStart(3, "0")}`,
      ),
    );

    const result = redactEventProperties(
      properties,
      approved,
      new Set<string>(),
    );
    const reordered = redactEventProperties(
      Object.fromEntries(Object.entries(properties).reverse()),
      approved,
      new Set<string>(),
    );

    expect(result).toEqual(reordered);
    expect(result.fingerprint).toHaveLength(FINGERPRINT_MAX_KEYS);
    expect(Object.keys(result.values).length).toBeLessThanOrEqual(
      REDACTED_PROPERTY_MAX_KEYS,
    );
    expect(Buffer.byteLength(JSON.stringify(result.values), "utf8")).toBeLessThanOrEqual(
      REDACTED_PROPERTY_MAX_BYTES,
    );
    expect(result).toMatchObject({
      truncated: true,
      warnings: ["redacted_evidence_truncated"],
    });
    expect(JSON.stringify(result)).not.toContain("unknown-secret-key");
    expect(JSON.stringify(result)).not.toContain("unknown-secret-value");
    for (const entry of result.fingerprint.filter(
      (entry) => entry.keyKind === "sha256",
    )) {
      expect(entry.key).toMatch(/^[a-f0-9]{24}$/);
    }
  });

  it("omits nested approved values and reads each top-level property once", () => {
    let reads = 0;
    const properties = Object.defineProperty({}, "Items", {
      enumerable: true,
      get() {
        reads += 1;
        return { nested: { deeper: { raw: "person@example.com" } } };
      },
    });

    const result = redactEventProperties(
      properties,
      new Set(["Items"]),
      new Set<string>(),
    );

    expect(reads).toBe(1);
    expect(result.values).toEqual({});
    expect(result.fingerprint).toEqual([
      { key: "Items", keyKind: "approved", type: "object" },
    ]);
    expect(JSON.stringify(result)).not.toContain("person@example.com");
  });
});
