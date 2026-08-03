import { describe, expect, it } from "vitest";
import {
  computeErasureSuppressionDigests,
  computeIdentityCryptoKeyChecks,
  computeIdentityDigests,
  deriveTenantIdentityKey,
  digestIdentityEmail,
  normalizeIdentityEmail,
  parseErasureSuppressionKey,
  parseIdentityHmacKeyring,
  type ErasureSuppressionKey,
  type IdentityHmacKey,
  type IdentityHmacKeyring,
} from "@/lib/identity-hmac";

const CURRENT_SECRET = Buffer.alloc(32, 7).toString("base64url");
const PREVIOUS_SECRET = Buffer.alloc(32, 9).toString("base64url");
const SUPPRESSION_SECRET = Buffer.alloc(32, 11).toString("base64url");

function suppressionEnv(
  values: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...values };
}

describe("identity HMAC", () => {
  it("normalizes email with trim and lowercase only", () => {
    expect(normalizeIdentityEmail("  Ivan.Example+Tag@Example.COM ")).toBe(
      "ivan.example+tag@example.com",
    );
  });

  it("is deterministic inside one tenant, store, and version", () => {
    const keyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
    });
    const input = {
      scope: { organizationId: "org_a", storeId: "store_a" },
      email: "person@example.com",
      keyring,
    };
    expect(computeIdentityDigests(input)).toEqual(computeIdentityDigests(input));
  });

  it("does not correlate the same email across tenants or stores", () => {
    const keyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
    });
    const digest = (organizationId: string, storeId: string) =>
      computeIdentityDigests({
        scope: { organizationId, storeId },
        email: "person@example.com",
        keyring,
      })[0].digest;

    expect(digest("org_a", "store_a")).not.toBe(digest("org_b", "store_a"));
    expect(digest("org_a", "store_a")).not.toBe(digest("org_a", "store_b"));
  });

  it("canonically frames ambiguous, empty, control, and multibyte scopes", () => {
    const keyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
    });
    const suppressionKey = parseErasureSuppressionKey(
      suppressionEnv({
        IDENTITY_ERASURE_HMAC_SECRET: SUPPRESSION_SECRET,
        IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
      }),
    );
    const matchingDigest = (scope: {
      organizationId: string;
      storeId: string;
    }) =>
      computeIdentityDigests({
        scope,
        email: "person@example.com",
        keyring,
      })[0].digest;
    const suppressionDigest = (scope: {
      organizationId: string;
      storeId: string;
    }) =>
      computeErasureSuppressionDigests({
        scope,
        key: suppressionKey,
        email: "person@example.com",
      })[0].digest;
    const formerlyColliding = [
      { organizationId: "org", storeId: "store:x" },
      { organizationId: "org:store", storeId: "x" },
    ] as const;

    expect(matchingDigest(formerlyColliding[0])).not.toBe(
      matchingDigest(formerlyColliding[1]),
    );
    expect(suppressionDigest(formerlyColliding[0])).not.toBe(
      suppressionDigest(formerlyColliding[1]),
    );
    const composed = { organizationId: "é", storeId: "store_a" };
    const decomposed = { organizationId: "e\u0301", storeId: "store_a" };
    expect(matchingDigest(composed)).not.toBe(matchingDigest(decomposed));
    expect(suppressionDigest(composed)).not.toBe(suppressionDigest(decomposed));

    const validScopes = [
      { organizationId: "", storeId: "" },
      { organizationId: "组织:α", storeId: "店舗\n🛒" },
      { organizationId: "org\t", storeId: "store\u007f" },
    ];
    for (const scope of validScopes) {
      expect(() => matchingDigest(scope)).not.toThrow();
      expect(() => suppressionDigest(scope)).not.toThrow();
    }
  });

  it("rejects NUL, unpaired surrogates, and non-string scope components", () => {
    const keyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
    });
    const suppressionKey = parseErasureSuppressionKey(
      suppressionEnv({
        IDENTITY_ERASURE_HMAC_SECRET: SUPPRESSION_SECRET,
        IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
      }),
    );
    const invalidScopes = [
      { organizationId: "org\0unsafe", storeId: "store_a" },
      { organizationId: "org_a", storeId: "store\0unsafe" },
      { organizationId: "high\ud800", storeId: "store_a" },
      { organizationId: "org_a", storeId: "low\udc00" },
      { organizationId: 42, storeId: "store_a" },
      { organizationId: "org_a", storeId: 42 },
      null,
    ] as unknown as Array<{ organizationId: string; storeId: string }>;

    for (const scope of invalidScopes) {
      expect(() =>
        computeIdentityDigests({
          scope,
          email: "person@example.com",
          keyring,
        }),
      ).toThrowError(/^Invalid identity scope$/);
      expect(() =>
        computeErasureSuppressionDigests({
          scope,
          key: suppressionKey,
          email: "person@example.com",
        }),
      ).toThrowError(/^Invalid identity scope$/);
    }
  });

  it("hashes blank matching email after trim-and-lower normalization", () => {
    const keyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
    });
    const scope = { organizationId: "org_a", storeId: "store_a" };
    const digest = (email: string) =>
      computeIdentityDigests({ scope, email, keyring })[0].digest;

    expect(digest("")).toBe(digest(" \t\n "));
    expect(digest("")).toHaveLength(43);
  });

  it("rejects direct structurally invalid matching and suppression keys", () => {
    const scope = { organizationId: "org_a", storeId: "store_a" };
    const validKeyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
    });
    const validSuppressionKey = parseErasureSuppressionKey(
      suppressionEnv({
        IDENTITY_ERASURE_HMAC_SECRET: SUPPRESSION_SECRET,
        IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
      }),
    );
    const invalidMatchingKeys = [
      null,
      { version: 2, secret: new Uint8Array(32) },
      { version: "invalid version", secret: new Uint8Array(32) },
      { version: "v1", secret: new Uint8Array(31) },
      { version: "v1", secret: CURRENT_SECRET },
    ] as unknown as IdentityHmacKey[];

    for (const key of invalidMatchingKeys) {
      expect(() => deriveTenantIdentityKey(key, scope)).toThrowError(
        /^Invalid identity HMAC key$/,
      );
      expect(() =>
        digestIdentityEmail({ scope, email: "person@example.com", key }),
      ).toThrowError(/^Invalid identity HMAC key$/);
      const keyring = { current: key } as IdentityHmacKeyring;
      expect(() =>
        computeIdentityDigests({
          scope,
          email: "person@example.com",
          keyring,
        }),
      ).toThrowError(/^Invalid identity HMAC key$/);
      expect(() =>
        computeIdentityCryptoKeyChecks({
          scope,
          keyring,
          suppressionKey: validSuppressionKey,
        }),
      ).toThrowError(/^Invalid identity HMAC key$/);
    }

    const invalidSuppressionKeys = [
      null,
      { version: 2, secret: new Uint8Array(32) },
      { version: "invalid version", secret: new Uint8Array(32) },
      { version: "e1", secret: new Uint8Array(31) },
      { version: "e1", secret: SUPPRESSION_SECRET },
    ] as unknown as ErasureSuppressionKey[];

    for (const key of invalidSuppressionKeys) {
      expect(() =>
        computeErasureSuppressionDigests({
          scope,
          key,
          email: "person@example.com",
        }),
      ).toThrowError(/^Invalid erasure suppression HMAC key$/);
      expect(() =>
        computeIdentityCryptoKeyChecks({
          scope,
          keyring: validKeyring,
          suppressionKey: key,
        }),
      ).toThrowError(/^Invalid erasure suppression HMAC key$/);
    }
  });

  it("rejects a direct matching keyring with repeated root material", () => {
    const repeatedSecret = new Uint8Array(32).fill(7);
    const keyring = {
      current: { version: "v2", secret: repeatedSecret },
      previous: { version: "v1", secret: repeatedSecret.slice() },
    };

    expect(() =>
      computeIdentityDigests({
        scope: { organizationId: "org_a", storeId: "store_a" },
        email: "person@example.com",
        keyring,
      }),
    ).toThrowError(
      /^Current and previous identity HMAC key material must differ$/,
    );
  });

  it("emits current and previous rows during rotation", () => {
    const keyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
      IDENTITY_HMAC_PREVIOUS_SECRET: PREVIOUS_SECRET,
      IDENTITY_HMAC_PREVIOUS_KEY_VERSION: "v1",
    });
    expect(
      computeIdentityDigests({
        scope: { organizationId: "org_a", storeId: "store_a" },
        email: "person@example.com",
        keyring,
      }).map(({ keyVersion, rotationState }) => ({ keyVersion, rotationState })),
    ).toEqual([
      { keyVersion: "v2", rotationState: "active" },
      { keyVersion: "v1", rotationState: "rotation_previous" },
    ]);
  });

  it("rejects short, incomplete, and same-version rotation configuration", () => {
    expect(() =>
      parseIdentityHmacKeyring({
        IDENTITY_HMAC_SECRET: Buffer.alloc(16, 1).toString("base64url"),
        IDENTITY_HMAC_KEY_VERSION: "v2",
      }),
    ).toThrow("at least 32 bytes");
    expect(() =>
      parseIdentityHmacKeyring({
        IDENTITY_HMAC_SECRET: CURRENT_SECRET,
        IDENTITY_HMAC_KEY_VERSION: "v2",
        IDENTITY_HMAC_PREVIOUS_SECRET: PREVIOUS_SECRET,
      }),
    ).toThrow("must be configured together");
    expect(() =>
      parseIdentityHmacKeyring({
        IDENTITY_HMAC_SECRET: CURRENT_SECRET,
        IDENTITY_HMAC_KEY_VERSION: "v2",
        IDENTITY_HMAC_PREVIOUS_SECRET: PREVIOUS_SECRET,
        IDENTITY_HMAC_PREVIOUS_KEY_VERSION: "v2",
      }),
    ).toThrow("must differ");
    expect(() =>
      parseIdentityHmacKeyring({
        IDENTITY_HMAC_SECRET: CURRENT_SECRET,
        IDENTITY_HMAC_KEY_VERSION: "v2",
        IDENTITY_HMAC_PREVIOUS_SECRET: CURRENT_SECRET,
        IDENTITY_HMAC_PREVIOUS_KEY_VERSION: "v1",
      }),
    ).toThrow("key material must differ");
    expect(() =>
      parseIdentityHmacKeyring({
        IDENTITY_HMAC_SECRET: "not+base64url",
        IDENTITY_HMAC_KEY_VERSION: "v2",
      }),
    ).toThrow("valid base64url");
    expect(() =>
      parseIdentityHmacKeyring({
        IDENTITY_HMAC_SECRET: CURRENT_SECRET,
        IDENTITY_HMAC_KEY_VERSION: "invalid version",
      }),
    ).toThrow("invalid");
  });

  it("never returns plaintext email or master secrets", () => {
    const keyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
    });
    const serialized = JSON.stringify(
      computeIdentityDigests({
        scope: { organizationId: "org_a", storeId: "store_a" },
        email: "person@example.com",
        keyring,
      }),
    );
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain(CURRENT_SECRET);
  });

  it("creates deterministic, domain-distinct suppression digests scoped by store", () => {
    const key = parseErasureSuppressionKey(
      suppressionEnv({
        IDENTITY_ERASURE_HMAC_SECRET: SUPPRESSION_SECRET,
        IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
      }),
    );
    const input = {
      scope: { organizationId: "org_a", storeId: "store_a" },
      key,
      email: "  Customer-Alias  ",
      shopifyCustomerId: "customer-alias",
    };
    const first = computeErasureSuppressionDigests(input);
    const second = computeErasureSuppressionDigests(input);
    const otherStore = computeErasureSuppressionDigests({
      ...input,
      scope: { organizationId: "org_a", storeId: "store_b" },
    });
    const otherOrganization = computeErasureSuppressionDigests({
      ...input,
      scope: { organizationId: "org_b", storeId: "store_a" },
    });

    expect(first).toEqual(second);
    expect(first.map(({ kind }) => kind)).toEqual([
      "email",
      "shopify_customer_id",
    ]);
    expect(first[0].digest).not.toBe(first[1].digest);
    expect(first[0].digest).not.toBe(otherStore[0].digest);
    expect(first[1].digest).not.toBe(otherStore[1].digest);
    expect(first[0].digest).not.toBe(otherOrganization[0].digest);
    expect(first[1].digest).not.toBe(otherOrganization[1].digest);
  });

  it("omits nullish suppression subjects but hashes present blank values", () => {
    const key = parseErasureSuppressionKey(
      suppressionEnv({
        IDENTITY_ERASURE_HMAC_SECRET: SUPPRESSION_SECRET,
        IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
      }),
    );
    const scope = { organizationId: "org_a", storeId: "store_a" };
    const compute = (
      subjects: {
        email?: string | null;
        shopifyCustomerId?: string | null;
      } = {},
    ) => computeErasureSuppressionDigests({ scope, key, ...subjects });

    expect(compute()).toEqual([]);
    expect(compute({ email: null })).toEqual([]);
    expect(compute({ shopifyCustomerId: null })).toEqual([]);
    expect(compute({ email: null, shopifyCustomerId: null })).toEqual([]);
    expect(
      compute({ email: null, shopifyCustomerId: "customer-123" }).map(
        ({ kind }) => kind,
      ),
    ).toEqual(["shopify_customer_id"]);
    expect(
      compute({ email: "person@example.com", shopifyCustomerId: null }).map(
        ({ kind }) => kind,
      ),
    ).toEqual(["email"]);
    expect(
      compute({
        email: "person@example.com",
        shopifyCustomerId: "customer-123",
      }).map(({ kind }) => kind),
    ).toEqual(["email", "shopify_customer_id"]);
    expect(
      compute({ email: "  ", shopifyCustomerId: "\t\n" }).map(
        ({ kind }) => kind,
      ),
    ).toEqual(["email", "shopify_customer_id"]);

    const emailDigest = (email: string) => compute({ email })[0].digest;
    expect(emailDigest("  ")).toBe(emailDigest("\t\n"));

    const customerDigest = (shopifyCustomerId: string) =>
      compute({ shopifyCustomerId })[0].digest;
    expect(customerDigest("  ")).not.toBe(customerDigest("\t\n"));
    expect(customerDigest(" customer-123 ")).not.toBe(
      customerDigest("customer-123"),
    );
  });

  it("matches literal known-answer vectors for persisted crypto domains", () => {
    const scope = { organizationId: "组织:α", storeId: "店舗\n🛒" };
    const keyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
    });
    const suppressionKey = parseErasureSuppressionKey(
      suppressionEnv({
        IDENTITY_ERASURE_HMAC_SECRET: SUPPRESSION_SECRET,
        IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
      }),
    );

    expect(
      computeIdentityDigests({
        scope,
        email: "person@example.com",
        keyring,
      })[0].digest,
    ).toBe("IGMjHENM9EquSx60gw0r6JyeC1VrBlpl4JpVyuOp0_0");
    expect(
      computeErasureSuppressionDigests({
        scope,
        key: suppressionKey,
        email: "person@example.com",
        shopifyCustomerId: "gid://shopify/Customer/123456",
      }).map(({ digest }) => digest),
    ).toEqual([
      "1l3HHbMrPVJVZ3BhNulnk7z4ilnwuz7rXtN19RZiUKA",
      "3VncFEJcIl3k--fLFdncZo1lK8Yy7bHfCNVXmCQbO0M",
    ]);
    expect(computeIdentityCryptoKeyChecks({ scope, keyring, suppressionKey })).toEqual(
      {
        matching: [
          {
            keyVersion: "v2",
            keyCheck: "8SAcj5-m6P8s3B1uByqbIfbLFXIoEM82IPpJKCLxY48",
          },
        ],
        suppression: {
          keyVersion: "e1",
          keyCheck: "H2IU_FYvbA28XqiaqwrvQxl2EeRrr_-jQxKPaLX1-ec",
        },
      },
    );
  });

  it("rejects missing, short, and invalid suppression key configuration", () => {
    expect(() => parseErasureSuppressionKey(suppressionEnv())).toThrow(
      "IDENTITY_ERASURE_HMAC_SECRET is required",
    );
    expect(() =>
      parseErasureSuppressionKey(
        suppressionEnv({
          IDENTITY_ERASURE_HMAC_SECRET: Buffer.alloc(16, 1).toString(
            "base64url",
          ),
          IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
        }),
      ),
    ).toThrow("at least 32 bytes");
    expect(() =>
      parseErasureSuppressionKey(
        suppressionEnv({
          IDENTITY_ERASURE_HMAC_SECRET: SUPPRESSION_SECRET,
          IDENTITY_ERASURE_HMAC_KEY_VERSION: "invalid version",
        }),
      ),
    ).toThrow("invalid");
  });

  it("creates deterministic, store-scoped, domain-distinct key checks", () => {
    const keyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
      IDENTITY_HMAC_PREVIOUS_SECRET: PREVIOUS_SECRET,
      IDENTITY_HMAC_PREVIOUS_KEY_VERSION: "v1",
    });
    const suppressionKey = parseErasureSuppressionKey(
      suppressionEnv({
        IDENTITY_ERASURE_HMAC_SECRET: SUPPRESSION_SECRET,
        IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
      }),
    );
    const input = {
      scope: { organizationId: "org_a", storeId: "store_a" },
      keyring,
      suppressionKey,
    };
    const first = computeIdentityCryptoKeyChecks(input);
    const otherStore = computeIdentityCryptoKeyChecks({
      ...input,
      scope: { organizationId: "org_a", storeId: "store_b" },
    });
    const otherOrganization = computeIdentityCryptoKeyChecks({
      ...input,
      scope: { organizationId: "org_b", storeId: "store_a" },
    });

    expect(first).toEqual(computeIdentityCryptoKeyChecks(input));
    expect(first.matching.map(({ keyVersion }) => keyVersion)).toEqual([
      "v2",
      "v1",
    ]);
    expect(first.matching[0].keyCheck).not.toBe(first.suppression.keyCheck);
    expect(first.matching[0].keyCheck).not.toBe(otherStore.matching[0].keyCheck);
    expect(first.matching[1].keyCheck).not.toBe(otherStore.matching[1].keyCheck);
    expect(first.suppression.keyCheck).not.toBe(otherStore.suppression.keyCheck);
    expect(first.matching[0].keyCheck).not.toBe(
      otherOrganization.matching[0].keyCheck,
    );
    expect(first.matching[1].keyCheck).not.toBe(
      otherOrganization.matching[1].keyCheck,
    );
    expect(first.suppression.keyCheck).not.toBe(
      otherOrganization.suppression.keyCheck,
    );

    expect(() =>
      computeIdentityCryptoKeyChecks({
        scope: input.scope,
        keyring,
        suppressionKey: parseErasureSuppressionKey(
          suppressionEnv({
            IDENTITY_ERASURE_HMAC_SECRET: CURRENT_SECRET,
            IDENTITY_ERASURE_HMAC_KEY_VERSION: "e2",
          }),
        ),
      }),
    ).toThrowError(/^Identity HMAC root key material must be independent$/);
    expect(() =>
      computeIdentityCryptoKeyChecks({
        scope: input.scope,
        keyring,
        suppressionKey: parseErasureSuppressionKey(
          suppressionEnv({
            IDENTITY_ERASURE_HMAC_SECRET: PREVIOUS_SECRET,
            IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
          }),
        ),
      }),
    ).toThrowError(/^Identity HMAC root key material must be independent$/);
  });

  it("changes key checks when either secret changes, even at the same version", () => {
    const scope = { organizationId: "org_a", storeId: "store_a" };
    const checks = (matchingSecret: string, suppressionSecret: string) =>
      computeIdentityCryptoKeyChecks({
        scope,
        keyring: parseIdentityHmacKeyring({
          IDENTITY_HMAC_SECRET: matchingSecret,
          IDENTITY_HMAC_KEY_VERSION: "v2",
        }),
        suppressionKey: parseErasureSuppressionKey(
          suppressionEnv({
            IDENTITY_ERASURE_HMAC_SECRET: suppressionSecret,
            IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
          }),
        ),
      });
    const baseline = checks(CURRENT_SECRET, SUPPRESSION_SECRET);
    const changedMatching = checks(PREVIOUS_SECRET, SUPPRESSION_SECRET);
    const changedSuppression = checks(CURRENT_SECRET, PREVIOUS_SECRET);

    expect(baseline.matching[0].keyCheck).not.toBe(
      changedMatching.matching[0].keyCheck,
    );
    expect(baseline.suppression.keyCheck).not.toBe(
      changedSuppression.suppression.keyCheck,
    );
  });

  it("does not expose subjects or either secret in suppression or key-check results", () => {
    const email = "private-person@example.com";
    const shopifyCustomerId = "gid://shopify/Customer/123456";
    const keyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
    });
    const suppressionKey = parseErasureSuppressionKey(
      suppressionEnv({
        IDENTITY_ERASURE_HMAC_SECRET: SUPPRESSION_SECRET,
        IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
      }),
    );
    const scope = { organizationId: "org_a", storeId: "store_a" };
    const serialized = JSON.stringify({
      suppression: computeErasureSuppressionDigests({
        scope,
        key: suppressionKey,
        email,
        shopifyCustomerId,
      }),
      checks: computeIdentityCryptoKeyChecks({ scope, keyring, suppressionKey }),
    });

    for (const sensitiveValue of [
      email,
      shopifyCustomerId,
      CURRENT_SECRET,
      SUPPRESSION_SECRET,
    ]) {
      expect(serialized).not.toContain(sensitiveValue);
    }
  });

  it("keeps the stable suppression key separate from the matching keyring", () => {
    const scope = { organizationId: "org_a", storeId: "store_a" };
    const matchingDigest = (suppressionSecret: string) => {
      const env = {
        IDENTITY_HMAC_SECRET: CURRENT_SECRET,
        IDENTITY_HMAC_KEY_VERSION: "v2",
        IDENTITY_ERASURE_HMAC_SECRET: suppressionSecret,
        IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
      };
      return computeIdentityDigests({
        scope,
        email: "person@example.com",
        keyring: parseIdentityHmacKeyring(env),
      });
    };
    const suppressionDigest = (matchingSecret: string) => {
      const env = {
        IDENTITY_HMAC_SECRET: matchingSecret,
        IDENTITY_HMAC_KEY_VERSION: "v2",
        IDENTITY_ERASURE_HMAC_SECRET: SUPPRESSION_SECRET,
        IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
      };
      return computeErasureSuppressionDigests({
        scope,
        key: parseErasureSuppressionKey(suppressionEnv(env)),
        email: "person@example.com",
      });
    };

    expect(matchingDigest(SUPPRESSION_SECRET)).toEqual(
      matchingDigest(PREVIOUS_SECRET),
    );
    expect(suppressionDigest(CURRENT_SECRET)).toEqual(
      suppressionDigest(PREVIOUS_SECRET),
    );
  });
});
