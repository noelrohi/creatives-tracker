import { describe, expect, it } from "vitest";
import {
  FINGERPRINT_MAX_KEYS,
  KLAVIYO_ALIAS_KEY_MAX_UTF8_BYTES,
  KLAVIYO_RAW_STRING_MAX_CODE_POINTS,
  KLAVIYO_RAW_STRING_MAX_UTF16_UNITS,
  KLAVIYO_RAW_STRING_MAX_UTF8_BYTES,
  REDACTED_PROPERTY_MAX_BYTES,
  REDACTED_PROPERTY_MAX_KEYS,
  REDACTED_PROPERTY_MAX_RAW_KEYS,
  isKlaviyoProviderOpaqueId,
  redactEventProperties,
  sanitizeKlaviyoSensitiveString,
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

  it("never reclassifies query or fragment slashes as an absolute URL path", () => {
    const result = redactEventProperties(
      {
        QueryOnly: "https://reviv.example.com?next=/customers/query-secret",
        FragmentOnly: "https://reviv.example.com#next=/customers/fragment-secret",
        EncodedDelimiter:
          "https://reviv.example.com/products/safe%3Fquery-secret",
      },
      new Set(["QueryOnly", "FragmentOnly", "EncodedDelimiter"]),
      new Set(["reviv.example.com"]),
    );

    expect(result.values).toEqual({
      EncodedDelimiter: "https://reviv.example.com/products/[redacted]",
      FragmentOnly: "https://reviv.example.com/",
      QueryOnly: "https://reviv.example.com/",
    });
    expect(JSON.stringify(Object.values(result.values))).not.toMatch(
      /query-secret|fragment-secret|next=/,
    );
  });

  it("classifies whitespace-prefixed absolute and relative paths before retaining generic fields", () => {
    const result = redactEventProperties(
      {
        GenericEvilAbsolute:
          "  https://evil.example/customers/absolute-secret?token=raw",
        GenericAllowedAbsolute:
          "  https://reviv.example.com/customers/allowed-secret?token=raw",
        GenericRelative:
          "  /customers/relative-secret?token=raw#fragment",
        TabPrefixed:
          "\thttps://reviv.example.com/customers/tab-secret?token=raw",
        NewlinePrefixed:
          "\n/customers/newline-secret?token=raw",
      },
      new Set([
        "GenericEvilAbsolute",
        "GenericAllowedAbsolute",
        "GenericRelative",
        "TabPrefixed",
        "NewlinePrefixed",
      ]),
      new Set(["reviv.example.com"]),
    );

    expect(result.values).toEqual({
      GenericAllowedAbsolute:
        "https://reviv.example.com/customers/[redacted]",
      GenericRelative: "/customers/[redacted]",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /evil\.example|absolute-secret|allowed-secret|relative-secret|tab-secret|newline-secret|token=raw/,
    );
  });

  it("retains prototype-shaped approved keys as safe own data properties", () => {
    const properties = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(properties, "__proto__", {
      enumerable: true,
      value: "safe-proto-value",
    });
    Object.defineProperty(properties, "constructor", {
      enumerable: true,
      value: "safe-constructor-value",
    });
    Object.defineProperty(properties, "prototype", {
      enumerable: true,
      value: "safe-prototype-value",
    });

    const result = redactEventProperties(
      properties,
      new Set(["__proto__", "constructor", "prototype"]),
      new Set<string>(),
    );

    expect(Object.getPrototypeOf(result.values)).toBeNull();
    expect(Object.hasOwn(result.values, "__proto__")).toBe(true);
    expect(Object.hasOwn(result.values, "constructor")).toBe(true);
    expect(Object.hasOwn(result.values, "prototype")).toBe(true);
    expect(JSON.parse(JSON.stringify(result.values))).toEqual(
      JSON.parse(
        '{"__proto__":"safe-proto-value","constructor":"safe-constructor-value","prototype":"safe-prototype-value"}',
      ),
    );
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
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

  it("normalizes and removes international, encoded, and credential-shaped secrets", () => {
    const secrets = {
      FullWidthEmail: "Contact ｕｓｅｒ＠ｅｘａｍｐｌｅ．ｃｏｍ",
      InternationalEmail: "联系 用户@例子.公司",
      EncodedEmail: "user%2540example.com",
      FullWidthPhone: "Call ＋６３ ９１７ １２３ ４５６７",
      Jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwZXJzb24ifQ.signature123",
      Bearer: "Bearer abcdefghijklmnopqrstuvwxyz012345",
      ApiKey: "sk_live_abcdefghijklmnopqrstuvwxyz",
      Credential: "password=customer-secret",
    };
    const result = redactEventProperties(
      secrets,
      new Set(Object.keys(secrets)),
      new Set<string>(),
    );

    const serialized = JSON.stringify(Object.values(result.values));
    expect(serialized).not.toMatch(
      /example|例子|９１７|917|eyJhbGci|Bearer|sk_live|customer-secret/i,
    );
    expect(result.values).toMatchObject({
      FullWidthEmail: "Contact [redacted]",
      InternationalEmail: "联系 [redacted]",
      EncodedEmail: "[redacted]",
      FullWidthPhone: "Call [redacted]",
    });
    expect(result.values).not.toHaveProperty("Jwt");
    expect(result.values).not.toHaveProperty("Bearer");
    expect(result.values).not.toHaveProperty("ApiKey");
    expect(result.values).not.toHaveProperty("Credential");
  });

  it("taints the next identity segment after invalid or residual percent encoding", () => {
    const result = redactEventProperties(
      {
        Invalid: "/customers/%ZZ/customer-secret/products/safe",
        Repeated: "/profiles/user%2525252540example.com/profile-secret",
      },
      new Set(["Invalid", "Repeated"]),
      new Set<string>(),
    );

    expect(result.values).toEqual({
      Invalid: "/customers/[redacted]/[redacted]/products/safe",
      Repeated: "/profiles/[redacted]/[redacted]",
    });
    expect(JSON.stringify(result)).not.toMatch(/customer-secret|profile-secret|example/);
  });

  it("taints the segment after malformed encoding outside identity-labeled paths", () => {
    const result = redactEventProperties(
      {
        Invalid: "/products/%ZZ/customer-id-must-not-survive",
        Residual:
          "/collections/%252525252F/customer-id-must-not-survive-either",
        Sensitive: "/collections/user@example.com/customer-id-after-email",
        Opaque:
          "/collections/abcdefghijklmnopqrstuvwxyz0123456789/customer-id-after-opaque",
      },
      new Set(["Invalid", "Residual", "Sensitive", "Opaque"]),
      new Set<string>(),
    );

    expect(result.values).toEqual({
      Invalid: "/products/[redacted]/[redacted]",
      Opaque: "/collections/[redacted]/[redacted]",
      Residual: "/collections/[redacted]/[redacted]",
      Sensitive: "/collections/[redacted]/[redacted]",
    });
    expect(JSON.stringify(result)).not.toContain("customer-id");
  });

  it("detects credentials without rewriting safe commerce strings", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwZXJzb24ifQ.signature123";
    const result = redactEventProperties(
      {
        BasicProductName: "Basic Black Dress",
        BasicCredential: "Basic dXNlcjpwYXNz",
        ShopifySecret: "shpat_abcdefghijklmnopqrstuvwxyz",
        AssignedJwt: `token=${jwt}`,
        AuthorizationJwt: `authorization=${jwt}`,
        DateSku: "2026-12-123456",
        EncodedSku: "SKU%20BLUE",
      },
      new Set([
        "BasicProductName",
        "BasicCredential",
        "ShopifySecret",
        "AssignedJwt",
        "AuthorizationJwt",
        "DateSku",
        "EncodedSku",
      ]),
      new Set<string>(),
    );

    expect(result.values).toEqual({
      BasicProductName: "Basic Black Dress",
      DateSku: "2026-12-123456",
      EncodedSku: "SKU%20BLUE",
    });
    expect(JSON.stringify(Object.values(result.values))).not.toMatch(
      /shpat_|eyJhbGci|dXNlcjpwYXNz/,
    );
  });

  it("separates bare-phone text detection from exact commerce identifiers", () => {
    const barePhone = "14155552671";
    const encodedEmail = "user%40example.com";
    const encodedCredential = "Bearer%20abcdefghijklmnopqrstuvwxyz";

    expect(sanitizeKlaviyoSensitiveString(barePhone, "text")).toBeNull();
    expect(sanitizeKlaviyoSensitiveString(barePhone, "identifier")).toBe(
      barePhone,
    );
    expect(sanitizeKlaviyoSensitiveString("50%OFF", "identifier")).toBe(
      "50%OFF",
    );
    expect(sanitizeKlaviyoSensitiveString(encodedEmail, "identifier")).toBeNull();
    expect(
      sanitizeKlaviyoSensitiveString(encodedCredential, "identifier"),
    ).toBeNull();
    expect(isKlaviyoProviderOpaqueId("event%2D1")).toBe(false);

    const result = redactEventProperties(
      { CustomerPhone: barePhone },
      new Set(["CustomerPhone"]),
      new Set<string>(),
    );
    expect(result.values).not.toHaveProperty("CustomerPhone");
    expect(JSON.stringify(result.values)).not.toContain(barePhone);
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

  it("rejects raw property maps before sorting or reading values beyond the cap", () => {
    let reads = 0;
    const properties: Record<string, unknown> = {};
    for (let index = 0; index <= REDACTED_PROPERTY_MAX_RAW_KEYS; index += 1) {
      Object.defineProperty(properties, `key-${String(index).padStart(4, "0")}`, {
        enumerable: true,
        get() {
          reads += 1;
          return "raw-secret";
        },
      });
    }

    expect(() =>
      redactEventProperties(properties, new Set<string>(), new Set<string>()),
    ).toThrow("redaction input is invalid");
    expect(reads).toBe(0);
  });

  it("rejects raw strings at UTF-16, UTF-8, and code-point work caps", () => {
    const oversized = [
      "x".repeat(KLAVIYO_RAW_STRING_MAX_CODE_POINTS + 1),
      "界".repeat(Math.floor(KLAVIYO_RAW_STRING_MAX_UTF8_BYTES / 3) + 1),
      "😀".repeat(Math.floor(KLAVIYO_RAW_STRING_MAX_UTF16_UNITS / 2) + 1),
    ];
    for (const value of oversized) {
      expect(() =>
        redactEventProperties(
          { Approved: value },
          new Set(["Approved"]),
          new Set<string>(),
        ),
      ).toThrow("redaction input is invalid");
    }
  });

  it("exports an alias byte cap below the general raw-string work cap", () => {
    expect(KLAVIYO_ALIAS_KEY_MAX_UTF8_BYTES).toBeLessThan(
      KLAVIYO_RAW_STRING_MAX_UTF8_BYTES,
    );
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
