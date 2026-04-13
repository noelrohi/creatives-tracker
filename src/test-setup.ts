// Stub out server-only so tRPC imports work in vitest
import { vi } from "vitest";

vi.mock("server-only", () => ({}));
