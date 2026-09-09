import type { BetterAuthOptions } from "better-auth";

type AuthInstance = {
  $context: Promise<unknown>;
  handler: (request: Request) => Promise<Response>;
  api: Record<string, (...args: never[]) => unknown>;
};

const connectionErrorCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT",
  "EAI_AGAIN", "08000", "08001", "08003", "08006", "57P01", "57P02", "57P03",
]);

function isConnectionError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (
      ("code" in error && connectionErrorCodes.has(String(error.code))) ||
      error.message === "Connection terminated unexpectedly" ||
      error.message === "Connection terminated due to connection timeout"
    ) {
      return true;
    }
    // Drizzle wraps the driver's error in a query error.
    error = error.cause;
  }
  return false;
}

export function createRecoverableAuth<T extends AuthInstance>(
  createAuth: () => T,
  options: BetterAuthOptions,
) {
  let initialization: Promise<T> | undefined;

  async function initialize(): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const auth = createAuth();
        // Better Auth caches this promise permanently, including rejections.
        // Recreate the instance only when initialization loses its connection.
        await auth.$context;
        return auth;
      } catch (error) {
        if (!isConnectionError(error) || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
  }

  function ready(): Promise<T> {
    initialization ??= initialize().catch(error => {
      if (isConnectionError(error)) {
        initialization = undefined;
        console.error("Auth initialization unavailable after 3 connection attempts");
      }
      throw error;
    });
    return initialization;
  }

  return {
    options,
    get $context(): T["$context"] {
      return ready().then(auth => auth.$context) as T["$context"];
    },
    async handler(request: Request): Promise<Response> {
      let auth: T;
      try {
        auth = await ready();
      } catch (error) {
        if (!isConnectionError(error)) throw error;
        return Response.json({ error: "Authentication temporarily unavailable" }, {
          status: 503,
          headers: { "Retry-After": "1", "Cache-Control": "no-store" },
        });
      }
      // Deliberately outside initialization recovery: never replay OAuth POSTs
      // (or other requests), even if execution fails with a connection error.
      return auth.handler(request);
    },
    // Server-side auth.api calls share the same initialization as HTTP routes.
    // Preserve Better Auth's inferred endpoint argument and return types.
    api: new Proxy({} as T["api"], {
      get(_target, property: string) {
        return async (...args: unknown[]) => {
          const auth = await ready();
          const endpoint = auth.api[property] as (...args: unknown[]) => unknown;
          return endpoint(...args);
        };
      },
    }),
  };
}
