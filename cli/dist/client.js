import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
const DEFAULT_API_URL = "http://localhost:3000";
export function getGlobalOptions(command) {
    return command.optsWithGlobals();
}
export function resolveApiUrl(command) {
    const options = getGlobalOptions(command);
    return options.url ?? process.env.ADSOLUTE_API_URL ?? DEFAULT_API_URL;
}
export function createApiClient(baseUrl) {
    return createTRPCClient({
        links: [
            httpBatchLink({
                url: `${baseUrl.replace(/\/$/, "")}/api/trpc`,
                transformer: superjson,
            }),
        ],
    });
}
