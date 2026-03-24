import { generateOpenApiDocument } from "@/lib/trpc/openapi";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return Response.json(generateOpenApiDocument(origin));
}
