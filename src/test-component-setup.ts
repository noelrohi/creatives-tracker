import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Iconify loads icon data asynchronously, which can schedule a React state
// update after jsdom has been torn down. Component tests exercise our labels
// and interactions, not Iconify's rendering, so keep icons synchronous here.
vi.mock("@iconify/react", () => ({
  Icon: () => null,
}));

afterEach(() => cleanup());
