import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "@/lib/trpc/routers/_app";

async function fetchJsonOrThrow(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    const body = await response.clone().text().catch(() => "");
    const preview = body.trim().slice(0, 500) || response.statusText;

    throw new Error(
      `Expected JSON from tRPC API, received ${response.status} ${response.statusText}: ${preview}`,
    );
  }

  return response;
}

export function createApiClient(baseUrl: string, apiKey: string, organizationId?: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl.replace(/\/$/, "")}/api/trpc`,
        transformer: superjson,
        fetch: fetchJsonOrThrow,
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
