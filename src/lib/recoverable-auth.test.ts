import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { mcp } from "@better-auth/mcp";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { organization, jwt } from "better-auth/plugins";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecoverableAuth } from "./recoverable-auth";

const base = "http://localhost:3000";
const request = (path = "get-session") => new Request(`${base}/api/auth/${path}`);
const resetError = () => new Error("Failed query: select from oauth_resource", {
  cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
});

function fixture() {
  const database = { oauthResource: [], session: [], user: [], jwks: [] };
  const readResource = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const executeOAuth = vi.fn();
  const executionError = resetError();
  const options = {
    baseURL: base,
    secret: "auth-recovery-test-secret-at-least-32-characters",
    database: (options: BetterAuthOptions) => {
      const adapter = memoryAdapter(database)(options);
      return {
        ...adapter,
        async findOne(args: Parameters<typeof adapter.findOne>[0]) {
          if (args.model === "oauthResource") await readResource();
          return adapter.findOne(args);
        },
      };
    },
    plugins: [
      organization(),
      jwt(),
      mcp({
        resource: `${base}/api/mcp`,
        loginPage: "/sign-in",
        consentPage: "/consent",
      }),
      {
        id: "oauth-execution-probe",
        onRequest: async (req) => {
          if (new URL(req.url).pathname === "/api/auth/oauth2/token") {
            executeOAuth(await req.text());
            // Model a token endpoint that has consumed the body and performed a
            // side effect before losing its DB connection. It must never replay.
            throw executionError;
          }
        },
      },
    ],
  } satisfies BetterAuthOptions;
  const createAuth = vi.fn(() => betterAuth(options));
  return { createAuth, readResource, executeOAuth, executionError, options };
}

// A real pg connection is closed while pg is waiting for the server. No
// external database or credentials are needed; all subsequent reads use the
// memory adapter, so database recovery is independent of auth recovery.
async function withDroppedConnection(
  run: (drop: () => Promise<void>) => Promise<void>,
) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", () => socket.resetAndDestroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP port");
  const pool = new Pool({
    host: "127.0.0.1",
    port: address.port,
    user: "test",
    database: "test",
    ssl: false,
    connectionTimeoutMillis: 1000,
  });
  try {
    await run(async () => {
      await pool.query("select 1 from oauth_resource limit 1");
    });
  } finally {
    await pool.end();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

afterEach(() => vi.useRealTimers());

describe("auth initialization recovery", () => {
  it("documents upstream caching: a real connection drop permanently rejects every route on the same raw instance", async () => {
    await withDroppedConnection(async (drop) => {
      const { createAuth, readResource } = fixture();
      readResource.mockImplementationOnce(drop);
      const auth = createAuth();
      const error = await auth.$context.catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/ECONNRESET|Connection terminated unexpectedly/);
      // The adapter would now succeed, but the rejected context is reused.
      for (const path of ["oauth2/authorize", "get-session", "organization/list"]) {
        await expect(auth.handler(request(path))).rejects.toBe(error);
      }
      expect(readResource).toHaveBeenCalledTimes(1);
      await expect(createAuth().handler(request())).resolves.toHaveProperty("status", 200);
    });
  });

  it("recovers on a later request after real connection drops exhaust initialization retries", async () => {
    await withDroppedConnection(async (drop) => {
      const { createAuth, readResource, options } = fixture();
      readResource.mockImplementation(drop);
      const auth = createRecoverableAuth(createAuth, options);
      const unavailable = await Promise.all([
        auth.handler(request("oauth2/authorize")),
        auth.handler(request()),
        auth.handler(request("organization/list")),
      ]);
      for (const response of unavailable) {
        expect(response.status).toBe(503);
        expect(response.headers.get("Retry-After")).toBe("1");
      }
      expect(createAuth).toHaveBeenCalledTimes(3);
      readResource.mockResolvedValue(undefined);
      expect((await auth.handler(request())).status).toBe(200);
      expect((await auth.handler(request("oauth2/authorize"))).status).toBe(302);
      expect((await auth.handler(request("organization/list"))).status).toBe(401);
      expect(createAuth).toHaveBeenCalledTimes(4);
    });
  });

  it("shares initialization and backoff across simultaneous HTTP and server API calls", async () => {
    vi.useFakeTimers();
    const { createAuth, readResource, options } = fixture();
    let release!: () => void;
    // First initialization is held open, then fails once released.
    readResource.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      throw resetError();
    }).mockResolvedValue(undefined);
    const auth = createRecoverableAuth(createAuth, options);
    const responses = Promise.all([
      auth.handler(request()), auth.handler(request()),
      auth.api.getSession({ headers: new Headers() }),
      auth.$context,
    ]);
    void responses.catch(() => {});
    await vi.waitFor(() => expect(readResource).toHaveBeenCalledTimes(1));
    expect(createAuth).toHaveBeenCalledTimes(1);
    release();
    await vi.runAllTimersAsync();
    const [first, second, session, context] = await responses;
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(session).toBeNull();
    expect(context.baseURL).toBe(`${base}/api/auth`);
    expect(createAuth).toHaveBeenCalledTimes(2);
    expect(readResource).toHaveBeenCalledTimes(2);
  });

  it("executes an OAuth POST once after init recovers, even if execution then loses its connection", async () => {
    vi.useFakeTimers();
    const { createAuth, readResource, executeOAuth, executionError, options } = fixture();
    readResource.mockRejectedValueOnce(resetError());
    const auth = createRecoverableAuth(createAuth, options);
    const result = auth.handler(new Request(`${base}/api/auth/oauth2/token`, {
      method: "POST", body: "grant_type=authorization_code&code=single-use",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    })).catch(error => error);
    await vi.runAllTimersAsync();
    expect(await result).toBe(executionError);
    expect(executeOAuth).toHaveBeenCalledExactlyOnceWith("grant_type=authorization_code&code=single-use");
    expect(createAuth).toHaveBeenCalledTimes(2);
    expect((await auth.handler(request())).status).toBe(200);
    expect(createAuth).toHaveBeenCalledTimes(2);
  });

  it("does not retry configuration or schema failures", async () => {
    const { createAuth, readResource, options } = fixture();
    const error = Object.assign(new Error("permission denied for table oauth_resource"), { code: "42501" });
    readResource.mockRejectedValue(error);
    const auth = createRecoverableAuth(createAuth, options);
    await expect(auth.handler(request())).rejects.toBe(error);
    await expect(auth.handler(request())).rejects.toBe(error);
    expect(createAuth).toHaveBeenCalledTimes(1);
  });
});
