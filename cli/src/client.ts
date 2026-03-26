import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { Command } from "commander";
import superjson from "superjson";
import type { AppRouter } from "../../src/lib/trpc/routers/_app.js";

const DEFAULT_API_URL = "http://localhost:3000";

export type CliClient = ReturnType<typeof createApiClient>;

type GlobalOptions = {
  apiKey?: string;
  table?: boolean;
  url?: string;
};

export function getGlobalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

export function resolveApiUrl(command: Command) {
  const options = getGlobalOptions(command);
  return options.url ?? process.env.ADSOLUTE_API_URL ?? DEFAULT_API_URL;
}

export function resolveApiKey(command: Command) {
  const options = getGlobalOptions(command);
  return options.apiKey ?? process.env.ADSOLUTE_API_KEY ?? undefined;
}

export function createApiClient(baseUrl: string, apiKey?: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl.replace(/\/$/, "")}/api/trpc`,
        transformer: superjson,
        headers: apiKey
          ? {
              authorization: `Bearer ${apiKey}`,
            }
          : undefined,
      }),
    ],
  });
}
