import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddCompetitorDialog } from "./add-competitor-dialog";

const mutate = vi.fn();

vi.mock("@/lib/trpc/client", () => ({
  useTRPC: () => ({
    signals: {
      listCompetitors: { queryKey: () => ["listCompetitors"] },
      addCompetitor: {
        mutationOptions: (options: unknown) => ({
          ...(options as object),
          mutationKey: ["addCompetitor"],
          mutationFn: (input: unknown) => {
            mutate(input);
            return Promise.resolve({ id: "competitor-1", name: "AIRWAAV" });
          },
        }),
      },
    },
  }),
}));

function renderDialog(onOpenChange = vi.fn()) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { mutations: { retry: false } },
        })
      }
    >
      <AddCompetitorDialog open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe("AddCompetitorDialog", () => {
  beforeEach(() => mutate.mockClear());

  it("opens an Ad Library search for the entered competitor name", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByRole("textbox", { name: "Name" }), "Grüns");

    const link = screen.getByRole("link", { name: /Open Meta Ad Library/ });
    const searchUrl = new URL(link.getAttribute("href") ?? "");
    expect(searchUrl.searchParams.get("q")).toBe("Grüns");
    expect(searchUrl.searchParams.get("country")).toBe("ALL");
    expect(searchUrl.searchParams.get("active_status")).toBe("active");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(
      screen.getByRole("textbox", { name: "Meta Ad Library page URL" }),
    ).toBeVisible();
  });

  it("extracts the page ID before adding the competitor", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByRole("textbox", { name: "Name" }), "AIRWAAV");
    await user.type(
      screen.getByRole("textbox", { name: "Meta Ad Library page URL" }),
      "https://www.facebook.com/ads/library/?active_status=active&view_all_page_id=109178280892310&country=US",
    );
    await user.click(screen.getByRole("button", { name: "Add competitor" }));

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        name: "AIRWAAV",
        metaPageId: "109178280892310",
      }),
    );
  });

  it("explains that an individual ad URL is not enough", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByRole("textbox", { name: "Name" }), "AIRWAAV");
    await user.type(
      screen.getByRole("textbox", { name: "Meta Ad Library page URL" }),
      "https://www.facebook.com/ads/library/?id=1234567890123456",
    );
    await user.click(screen.getByRole("button", { name: "Add competitor" }));

    expect(
      await screen.findByText(
        "Open the advertiser's page in Meta Ad Library, then copy that page URL.",
      ),
    ).toBeVisible();
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([
    "not a url",
    "https://example.com/ads/library/?view_all_page_id=109178280892310",
  ])("rejects invalid input: %s", async (url) => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByRole("textbox", { name: "Name" }), "AIRWAAV");
    await user.type(
      screen.getByRole("textbox", { name: "Meta Ad Library page URL" }),
      url,
    );
    await user.click(screen.getByRole("button", { name: "Add competitor" }));

    expect(
      await screen.findByText("Paste a Meta Ad Library advertiser page URL."),
    ).toBeVisible();
    expect(mutate).not.toHaveBeenCalled();
  });
});
