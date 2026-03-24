import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { toJSONSchema, type ZodTypeAny } from "zod";
import { createContext } from "./init";
import type { OpenApiMeta, OpenApiMethod } from "./openapi-meta";
import { appRouter } from "./routers/_app";

const EXCLUDED_OPENAPI_ROUTERS = new Set(["abTest"]);

type JsonSchema = Record<string, unknown>;

type ProcedureLike = {
  _def: {
    procedure?: boolean;
    inputs?: unknown[];
    meta?: OpenApiMeta;
  };
};

type OpenApiProcedure = {
  routerName: string;
  procedureName: string;
  method: OpenApiMethod;
  path: `/${string}`;
  summary?: string;
  tags: string[];
  inputSchema?: ZodTypeAny;
};

function isProcedure(value: unknown): value is ProcedureLike {
  return Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      (value as ProcedureLike)._def?.procedure,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isZodSchema(value: unknown): value is ZodTypeAny {
  return Boolean(
    value &&
      typeof value === "object" &&
      "safeParse" in value &&
      "toJSONSchema" in value,
  );
}

function getProcedureInputSchema(procedure: ProcedureLike) {
  const [schema] = procedure._def.inputs ?? [];
  return isZodSchema(schema) ? schema : undefined;
}

function getObjectShapeFromSchema(schema: JsonSchema | undefined) {
  if (!schema || schema.type !== "object") {
    return {
      properties: {} as Record<string, JsonSchema>,
      required: new Set<string>(),
    };
  }

  const properties = isRecord(schema.properties)
    ? (schema.properties as Record<string, JsonSchema>)
    : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );

  return { properties, required };
}

function coerceQueryValue(
  value: string | string[],
  schema: JsonSchema | undefined,
): unknown {
  if (!schema) {
    return value;
  }

  if (schema.type === "array") {
    const rawValues = Array.isArray(value)
      ? value
      : value.split(",").map((part) => part.trim());
    const itemSchema = isRecord(schema.items)
      ? (schema.items as JsonSchema)
      : undefined;
    return rawValues.map((item) => coerceQueryValue(item, itemSchema));
  }

  if (Array.isArray(value)) {
    return value[value.length - 1];
  }

  if (schema.type === "integer" || schema.type === "number") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  }

  if (schema.type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
  }

  return value;
}

function getInputSchemaJson(schema?: ZodTypeAny) {
  if (!schema) {
    return undefined;
  }

  return toJSONSchema(schema, {
    target: "openapi-3.0",
    reused: "inline",
  }) as JsonSchema;
}

function getQueryInput(
  searchParams: URLSearchParams,
  schema?: ZodTypeAny,
): Record<string, unknown> | undefined {
  if (!schema) {
    return undefined;
  }

  const jsonSchema = getInputSchemaJson(schema);
  const { properties } = getObjectShapeFromSchema(jsonSchema);
  const entries = new Map<string, string[]>();

  for (const [key, value] of searchParams.entries()) {
    const existing = entries.get(key);
    if (existing) {
      existing.push(value);
    } else {
      entries.set(key, [value]);
    }
  }

  if (entries.size === 0) {
    return undefined;
  }

  const input: Record<string, unknown> = {};

  for (const [key, values] of entries) {
    const propertySchema = properties[key];
    input[key] = coerceQueryValue(
      values.length > 1 ? values : values[0],
      propertySchema,
    );
  }

  return input;
}

function getJsonSchemaParameters(schema?: ZodTypeAny) {
  const jsonSchema = getInputSchemaJson(schema);
  const { properties, required } = getObjectShapeFromSchema(jsonSchema);

  return Object.entries(properties).map(([name, propertySchema]) => {
    const parameter: Record<string, unknown> = {
      name,
      in: "query",
      required: required.has(name),
      schema: propertySchema,
    };

    if (propertySchema.type === "array") {
      parameter.style = "form";
      parameter.explode = true;
    }

    return parameter;
  });
}

function getRequestBody(schema?: ZodTypeAny) {
  const jsonSchema = getInputSchemaJson(schema);

  if (!jsonSchema) {
    return undefined;
  }

  return {
    required: true,
    content: {
      "application/json": {
        schema: jsonSchema,
      },
    },
  };
}

function collectOpenApiProcedures(
  record: Record<string, unknown>,
  routerName?: string,
): OpenApiProcedure[] {
  const procedures: OpenApiProcedure[] = [];

  for (const [key, value] of Object.entries(record)) {
    if (!routerName && isRecord(value)) {
      procedures.push(...collectOpenApiProcedures(value, key));
      continue;
    }

    if (!routerName || !isProcedure(value)) {
      continue;
    }

    const openapi = value._def.meta?.openapi;

    if (!openapi) {
      continue;
    }

    procedures.push({
      routerName,
      procedureName: key,
      method: openapi.method,
      path: openapi.path,
      summary: openapi.summary,
      tags: openapi.tags ?? [routerName],
      inputSchema: getProcedureInputSchema(value),
    });
  }

  return procedures;
}

export function getOpenApiProcedures() {
  return collectOpenApiProcedures(
    appRouter._def.record as Record<string, unknown>,
  ).filter((procedure) => !EXCLUDED_OPENAPI_ROUTERS.has(procedure.routerName));
}

export function getOpenApiProcedure(
  routerName: string,
  procedureName: string,
) {
  return getOpenApiProcedures().find(
    (procedure) =>
      procedure.routerName === routerName &&
      procedure.procedureName === procedureName,
  );
}

export function generateOpenApiDocument(baseUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const procedure of getOpenApiProcedures()) {
    const operation: Record<string, unknown> = {
      operationId: `${procedure.routerName}.${procedure.procedureName}`,
      tags: procedure.tags,
      summary: procedure.summary,
      responses: {
        "200": {
          description: "Successful response",
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: true,
              },
            },
          },
        },
      },
    };

    if (procedure.method === "GET") {
      operation.parameters = getJsonSchemaParameters(procedure.inputSchema);
    } else {
      const requestBody = getRequestBody(procedure.inputSchema);
      if (requestBody) {
        operation.requestBody = requestBody;
      }
    }

    paths[procedure.path] = {
      ...(paths[procedure.path] ?? {}),
      [procedure.method.toLowerCase()]: operation,
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "Adsolute tRPC API",
      version: "1.0.0",
      description:
        "Internal REST bridge generated from the app's tRPC router for interactive docs and CLI development.",
    },
    servers: [{ url: baseUrl }],
    paths,
  };
}

async function getCaller() {
  return appRouter.createCaller(await createContext());
}

export async function callOpenApiProcedure(
  request: Request,
  routerName: string,
  procedureName: string,
) {
  const procedure = getOpenApiProcedure(routerName, procedureName);

  if (!procedure) {
    return Response.json(
      { message: "Procedure not found" },
      { status: 404 },
    );
  }

  if (request.method !== procedure.method) {
    return Response.json(
      {
        message: `Method ${request.method} not allowed for ${routerName}.${procedureName}`,
      },
      { status: 405 },
    );
  }

  try {
    const caller = await getCaller();
    const routerCaller = (caller as Record<string, Record<string, unknown>>)[
      routerName
    ];

    if (!routerCaller) {
      return Response.json({ message: "Router not found" }, { status: 404 });
    }

    const procedureCaller = routerCaller[procedureName];

    if (typeof procedureCaller !== "function") {
      return Response.json(
        { message: "Procedure caller not found" },
        { status: 404 },
      );
    }

    let input: unknown;

    if (procedure.method === "GET") {
      input = getQueryInput(
        new URL(request.url).searchParams,
        procedure.inputSchema,
      );
    } else if (request.headers.get("content-length") !== "0") {
      const contentType = request.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        input = await request.json();
      }
    }

    const result =
      input === undefined
        ? await (procedureCaller as () => Promise<unknown>)()
        : await (procedureCaller as (value: unknown) => Promise<unknown>)(input);

    return Response.json(result);
  } catch (error) {
    if (error instanceof TRPCError) {
      return Response.json(
        {
          message: error.message,
          code: error.code,
        },
        { status: getHTTPStatusCodeFromError(error) },
      );
    }

    const message =
      error instanceof Error ? error.message : "Unknown error";

    return Response.json(
      {
        message,
      },
      { status: 500 },
    );
  }
}
