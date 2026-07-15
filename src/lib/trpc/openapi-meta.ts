export type OpenApiMethod = "GET" | "POST";

export type OpenApiMeta = {
  openapi?: {
    method: OpenApiMethod;
    path: `/${string}`;
    summary?: string;
    description?: string;
    tags?: string[];
  };
};

export function buildOpenApiPath(
  routerName: string,
  procedureName: string,
): `/${string}` {
  return `/api/openapi/${routerName}/${procedureName}`;
}

export function openApiQueryMeta(
  routerName: string,
  procedureName: string,
  summary?: string,
  description?: string,
): OpenApiMeta {
  return {
    openapi: {
      method: "GET",
      path: buildOpenApiPath(routerName, procedureName),
      summary,
      description,
    },
  };
}

export function openApiMutationMeta(
  routerName: string,
  procedureName: string,
  summary?: string,
  description?: string,
): OpenApiMeta {
  return {
    openapi: {
      method: "POST",
      path: buildOpenApiPath(routerName, procedureName),
      summary,
      description,
    },
  };
}
