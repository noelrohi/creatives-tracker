import { callOpenApiProcedure } from "@/lib/trpc/openapi";

type RouteContext = {
  params: Promise<{
    router: string;
    procedure: string;
  }>;
};

async function handler(request: Request, context: RouteContext) {
  const { router, procedure } = await context.params;
  return callOpenApiProcedure(request, router, procedure);
}

export async function GET(request: Request, context: RouteContext) {
  return handler(request, context);
}

export async function POST(request: Request, context: RouteContext) {
  return handler(request, context);
}
