import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "@/lib/trpc/routers/_app";

export function createApiClient(baseUrl: string, apiKey: string, organizationId?: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl.replace(/\/$/, "")}/api/trpc`,
        transformer: superjson,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(organizationId ? { "x-adsolute-organization-id": organizationId } : {}),
        },
      }),
    ],
  });
}

export function getEnvConfig() {
  const apiUrl = process.env.ADSOLUTE_API_URL;
  const apiKey = process.env.ADSOLUTE_WORKER_SECRET;

  if (!apiUrl) throw new Error("ADSOLUTE_API_URL is required");
  if (!apiKey) throw new Error("ADSOLUTE_WORKER_SECRET is required");

  return { apiUrl, apiKey };
}
