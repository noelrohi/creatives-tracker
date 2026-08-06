import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LabPanelState } from "./panel-state";

describe("LabPanelState", () => {
  it("distinguishes a failed query from an empty result and retries it", async () => {
    const retry = vi.fn();
    render(
      <LabPanelState
        kind="error"
        title="Orders could not load"
        body="Previously loaded evidence remains unchanged."
        onRetry={retry}
      />,
    );

    expect(screen.getByText("Orders could not load")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("offers Clear filters only for a filtered-empty state", async () => {
    const clear = vi.fn();
    render(
      <LabPanelState
        kind="filtered-empty"
        title="No orders match"
        body="Loosen the evidence filters to see more orders."
        onClearFilters={clear}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(clear).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("renders skeleton rows while loading and plain text when empty", () => {
    const { container, rerender } = render(
      <LabPanelState kind="loading" title="Loading" body="" />,
    );
    expect(container.querySelectorAll("[data-slot=skeleton]").length).toBe(3);
    rerender(
      <LabPanelState
        kind="empty"
        title="No Klaviyo evidence yet"
        body="Run discovery to begin."
      />,
    );
    expect(screen.getByText("No Klaviyo evidence yet")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
