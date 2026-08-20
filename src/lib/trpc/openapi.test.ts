import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { baseProcedure, router } from "./init";
import { formatTrpcErrorMessage, generateOpenApiDocument } from "./openapi";
import { openApiMutationMeta, openApiQueryMeta } from "./openapi-meta";
import { appRouter } from "./routers/_app";

const BASE_URL = "https://api.example.test";

const fixtureRouter = router({
  fixture: router({
    declaredOutput: baseProcedure
      .meta(openApiQueryMeta("fixture", "declaredOutput"))
      .input(z.object({ inputOnly: z.string() }))
      .output(
        z.object({
          createdAt: z.date(),
          values: z.array(z.number()),
        }),
      )
      .query(() => ({ createdAt: new Date(), values: [1, 2] })),
    arrayOutput: baseProcedure
      .meta(openApiQueryMeta("fixture", "arrayOutput"))
      .output(z.array(z.object({ id: z.string() })))
      .query(() => [{ id: "one" }]),
    voidOutput: baseProcedure
      .meta(openApiMutationMeta("fixture", "voidOutput"))
      .output(z.void())
      .mutation(() => undefined),
    metaless: baseProcedure
      .output(z.object({ hidden: z.boolean() }))
      .query(() => ({ hidden: true })),
  }),
});

function generateFixtureDocument() {
  return generateOpenApiDocument(
    BASE_URL,
    fixtureRouter._def.record as Record<string, unknown>,
  );
}

const EXPECTED_PROCEDURES = {
  adCreative: [
    "list",
    "trackerList",
    "dashboardStats",
    "landingPages",
    "exportAgentRows",
    "portfolioSummary",
    "dashboardExport",
    "getDailyPortfolioPerformance",
    "getMerAccountBreakdown",
    "getById",
    "getAdPreviewUrl",
    "fetchMetaPreview",
    "create",
    "update",
    "duplicate",
    "bulkUpdateOwnership",
    "bulkUpdateTeam",
    "bulkImport",
    "getPerformance",
    "getDailyPerformance",
    "delete",
  ],
  campaign: [
    "list",
    "getById",
    "create",
    "update",
    "duplicate",
    "bulkImport",
    "delete",
  ],
  adSet: [
    "list",
    "listByCampaign",
    "getById",
    "create",
    "update",
    "duplicate",
    "bulkImport",
    "delete",
  ],
  ad: [
    "list",
    "listByAdSet",
    "listByCreative",
    "getById",
    "create",
    "update",
    "pauseMetaAds",
    "renameMetaAd",
    "duplicate",
    "bulkImport",
    "delete",
  ],
  performanceLog: [
    "listAll",
    "listByAd",
    "demographicBreakdown",
    "creativeDemographicBreakdown",
    "exportByAccount",
    "create",
    "bulkCreate",
    "update",
    "delete",
  ],
  manager: ["campaigns", "adSets", "ads"],
  tag: ["search", "listForEntity", "attach", "detach"],
  adAccount: ["list", "getById", "create", "update", "delete"],
  apiKey: ["list", "create", "revoke", "delete"],
  team: ["list", "getById", "create", "update", "delete"],
  signals: ["ingestFill", "rankedSignals", "ingestTestPlan", "planFeedback"],
  performanceSummary: ["monthlyOverview"],
  attribution: [
    "overview",
    "metaCheck",
    "campaignLedger",
    "dailySeries",
    "syncStatus",
  ],
  findings: ["list", "checks"],
} as const;

const EXPECTED_PATHS = Object.entries(EXPECTED_PROCEDURES)
  .flatMap(([routerName, procedureNames]) =>
    procedureNames.map(
      (procedureName) => `/api/openapi/${routerName}/${procedureName}`,
    ),
  )
  .sort();

const NEW_PATHS = [
  "/api/openapi/adCreative/landingPages",
  "/api/openapi/adCreative/exportAgentRows",
  "/api/openapi/adCreative/portfolioSummary",
  "/api/openapi/adCreative/dashboardExport",
  "/api/openapi/performanceLog/demographicBreakdown",
  "/api/openapi/performanceLog/creativeDemographicBreakdown",
  "/api/openapi/performanceLog/exportByAccount",
];

type Operation = {
  tags?: unknown;
  summary?: unknown;
  security?: unknown;
  responses?: {
    "200"?: {
      content?: {
        "application/json"?: {
          schema?: unknown;
        };
      };
    };
  };
};

function getOperations(document: ReturnType<typeof generateOpenApiDocument>) {
  return Object.entries(document.paths).flatMap(([path, pathItem]) =>
    Object.entries(pathItem).map(([method, operation]) => ({
      path,
      method,
      operation: operation as Operation,
    })),
  );
}

function getResponseSchema(operation: Operation) {
  return operation.responses?.["200"]?.content?.["application/json"]?.schema;
}

describe("OpenAPI generator unit fixtures", () => {
  it("uses declared output schemas and preserves dates and arrays", () => {
    const document = generateFixtureDocument();
    const operation = document.paths["/api/openapi/fixture/declaredOutput"]
      ?.get as Operation;

    expect(getResponseSchema(operation)).toMatchObject({
      type: "object",
      properties: {
        createdAt: {
          type: "string",
          format: "date-time",
          description: "ISO 8601 date-time string",
        },
        values: {
          type: "array",
          items: { type: "number" },
        },
      },
      required: ["createdAt", "values"],
    });
  });

  it("preserves top-level array outputs", () => {
    const document = generateFixtureDocument();
    const operation = document.paths["/api/openapi/fixture/arrayOutput"]
      ?.get as Operation;

    expect(getResponseSchema(operation)).toMatchObject({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    });
  });

  it("renders void outputs as JSON null", () => {
    const document = generateFixtureDocument();
    const operation = document.paths["/api/openapi/fixture/voidOutput"]
      ?.post as Operation;

    expect(getResponseSchema(operation)).toEqual({ type: "null" });
  });

  it("does not emit an operation for a metaless procedure", () => {
    const document = generateFixtureDocument();

    expect(document.paths["/api/openapi/fixture/metaless"]).toBeUndefined();
    expect(getOperations(document)).toHaveLength(3);
  });
});

describe("OpenAPI app inventory", () => {
  const document = generateOpenApiDocument(
    BASE_URL,
    appRouter._def.record as Record<string, unknown>,
  );
  const operations = getOperations(document);
  const nonStudioOperations = operations.filter(
    ({ path }) => !path.startsWith("/api/openapi/studio/"),
  );

  it("contains exactly the expected 89 non-studio paths", () => {
    expect(nonStudioOperations).toHaveLength(89);
    expect(
      Object.keys(document.paths)
        .filter((path) => !path.startsWith("/api/openapi/studio/"))
        .sort(),
    ).toEqual(EXPECTED_PATHS);

    for (const [routerName, procedureNames] of Object.entries(
      EXPECTED_PROCEDURES,
    )) {
      expect(
        nonStudioOperations.filter((operation) =>
          operation.path.startsWith(`/api/openapi/${routerName}/`),
        ),
      ).toHaveLength(procedureNames.length);
    }
  });

  it("includes Studio operations", () => {
    expect(
      operations.filter(({ path }) => path.startsWith("/api/openapi/studio/"))
        .length,
    ).toBeGreaterThan(0);
  });

  it("omits internal and dead router operations", () => {
    expect(
      Object.keys(document.paths).some(
        (path) => path.includes("/metaSync/") || path.includes("/abTest/"),
      ),
    ).toBe(false);
  });

  it("contains all seven newly documented query paths", () => {
    for (const path of NEW_PATHS) {
      expect(document.paths[path]).toBeDefined();
    }
  });

  it("gives every operation tags, a summary, and a typed response", () => {
    for (const { operation } of operations) {
      expect(Array.isArray(operation.tags)).toBe(true);
      expect((operation.tags as unknown[]).length).toBeGreaterThan(0);
      expect(typeof operation.summary).toBe("string");
      expect((operation.summary as string).length).toBeGreaterThan(0);
      expect(getResponseSchema(operation)).not.toEqual({
        type: "object",
        additionalProperties: true,
      });
    }
  });

  it("renders team tag metadata", () => {
    expect(document.tags).toContainEqual({
      name: "Teams",
      description: "Manage teams for creative ownership",
    });
  });

  it("keeps API key operations session-only", () => {
    const apiKeyOperations = operations.filter(({ path }) =>
      path.startsWith("/api/openapi/apiKey/"),
    );

    expect(apiKeyOperations).toHaveLength(4);
    for (const { operation } of apiKeyOperations) {
      expect(operation.security).toEqual([{ sessionCookie: [] }]);
    }
  });
});

describe("validation error messages", () => {
  const rangeSchema = z
    .object({
      dateFrom: z.string(),
      dateTo: z.string(),
    })
    .refine((value) => value.dateFrom <= value.dateTo, {
      message: "dateFrom must be on or before dateTo",
      path: ["dateFrom"],
    });

  function badRequestFrom(input: unknown) {
    const result = rangeSchema.safeParse(input);
    if (result.success) {
      throw new Error("expected the fixture input to fail validation");
    }
    return new TRPCError({
      code: "BAD_REQUEST",
      message: JSON.stringify(result.error.issues, null, 2),
      cause: result.error,
    });
  }

  it("names every missing field instead of dumping the issue array", () => {
    const message = formatTrpcErrorMessage(badRequestFrom({}));

    expect(message).toBe(
      "dateFrom: expected string, received undefined; dateTo: expected string, received undefined",
    );
    expect(message).not.toContain("[");
  });

  it("does not stutter when a refinement already names its field", () => {
    expect(
      formatTrpcErrorMessage(
        badRequestFrom({ dateFrom: "2026-08-17", dateTo: "2026-08-01" }),
      ),
    ).toBe("dateFrom must be on or before dateTo");
  });

  it("flattens issues carried only in the message, without a cause", () => {
    const original = badRequestFrom({});
    const rethrown = new TRPCError({
      code: "BAD_REQUEST",
      message: original.message,
    });

    expect(formatTrpcErrorMessage(rethrown)).toBe(
      "dateFrom: expected string, received undefined; dateTo: expected string, received undefined",
    );
  });

  it("leaves non-validation messages untouched", () => {
    expect(
      formatTrpcErrorMessage(
        new TRPCError({
          code: "FORBIDDEN",
          message: 'API key is missing required "write" scope',
        }),
      ),
    ).toBe('API key is missing required "write" scope');
  });

  it("leaves a message that merely starts with a bracket untouched", () => {
    expect(
      formatTrpcErrorMessage(
        new TRPCError({ code: "NOT_FOUND", message: "[store] not connected" }),
      ),
    ).toBe("[store] not connected");
  });
});
