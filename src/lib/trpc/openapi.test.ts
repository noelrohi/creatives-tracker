import { describe, expect, it } from "vitest";
import { z } from "zod";
import { baseProcedure, router } from "./init";
import { generateOpenApiDocument } from "./openapi";
import { openApiQueryMeta } from "./openapi-meta";

const fixtureRouter = router({
  fixture: router({
    declaredOutput: baseProcedure
      .meta(openApiQueryMeta("fixture", "declaredOutput"))
      .output(z.object({ derivedFromOutput: z.string() }))
      .query(() => ({ derivedFromOutput: "yes" })),
  }),
  adCreative: router({
    list: baseProcedure
      .meta(openApiQueryMeta("adCreative", "list"))
      .output(z.object({ declaredOutputWins: z.literal(true) }))
      .query(() => ({ declaredOutputWins: true as const })),
  }),
  studio: router({
    describe: baseProcedure
      .meta(
        openApiQueryMeta(
          "studio",
          "describe",
          "Describe studio",
          "Detailed studio operation description",
        ),
      )
      .query(() => ({})),
  }),
});

function generateFixtureDocument() {
  return generateOpenApiDocument(
    "https://api.example.test",
    fixtureRouter._def.record as Record<string, unknown>,
  );
}

describe("generateOpenApiDocument", () => {
  it("derives response schemas from declared procedure outputs", () => {
    const document = generateFixtureDocument();

    expect(document.paths["/api/openapi/fixture/declaredOutput"]).toMatchObject({
      get: {
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    derivedFromOutput: { type: "string" },
                  },
                  required: ["derivedFromOutput"],
                },
              },
            },
          },
        },
      },
    });
  });

  it("prefers declared outputs over custom response schemas", () => {
    const document = generateFixtureDocument();

    expect(document.paths["/api/openapi/adCreative/list"]).toMatchObject({
      get: {
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    declaredOutputWins: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it("emits operation descriptions and studio tag metadata", () => {
    const document = generateFixtureDocument();

    expect(document.paths["/api/openapi/studio/describe"]).toMatchObject({
      get: {
        summary: "Describe studio",
        description: "Detailed studio operation description",
      },
    });
    expect(document.tags).toContainEqual({
      name: "studio",
      description:
        "Image Studio: swipe file, weekly suggestions, generation queue, and library curation",
    });
  });
});
