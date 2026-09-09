// Stub out server-only so tRPC imports work in vitest
import { vi } from "vitest";

vi.mock("server-only", () => ({}));

// Keep unit tests isolated from the real auth config and its plugins. Auth
// integration tests opt out with vi.unmock; tests that need a specific shape
// (e.g. upload route) mock @/lib/auth themselves.
vi.mock("@/lib/auth", () => ({
  auth: { api: {}, handler: () => new Response(null, { status: 404 }) },
  mcpResource: "http://localhost:3000/api/mcp",
}));
