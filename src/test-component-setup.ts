import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Iconify loads icon data asynchronously, which can schedule a React state
// update after jsdom has been torn down. Component tests exercise our labels
// and interactions, not Iconify's rendering, so keep icons synchronous here.
vi.mock("@iconify/react", () => ({
  Icon: () => null,
}));

// jsdom has no layout engine, so it doesn't implement ResizeObserver. Recharts'
// ResponsiveContainer needs one to mount at all — this no-op stub is enough for
// components under test to render without a real observer ever firing.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

afterEach(() => cleanup());
