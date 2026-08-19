// Stub out server-only so tRPC imports work in vitest
import { vi } from "vitest";

vi.mock("server-only", () => ({}));

// Stub the Better Auth instance: constructing it kicks off plugin init that
// reads the database (OAuth resource seeding), which the per-file db mocks
// can't serve. No test exercises auth itself; the ones that need a specific
// shape (e.g. upload route) mock @/lib/auth themselves.
vi.mock("@/lib/auth", () => ({
  auth: { api: {}, handler: () => new Response(null, { status: 404 }) },
  mcpResource: "http://localhost:3000/api/mcp",
}));
