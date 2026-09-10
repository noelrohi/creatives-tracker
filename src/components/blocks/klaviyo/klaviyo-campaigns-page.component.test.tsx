import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KlaviyoCampaignsPage } from "./klaviyo-campaigns-page";

const queryState = vi.hoisted(() => ({
  contextFn: (): Promise<unknown> => Promise.resolve(null),
  listFn: (): Promise<unknown> =>
    Promise.resolve({
      rows: [],
      report: {
        asOf: null,
        hasCampaignGeneration: false,
        hasFlowGeneration: false,
      },
    }),
  detailFn: (): Promise<unknown> => Promise.resolve(null),
  role: "member" as "member" | "admin" | "owner",
}));

vi.mock("@/lib/trpc/client", () => ({
  useTRPC: () => ({
    klaviyo: {
      ledgerContext: {
        queryOptions: () => ({
          queryKey: ["ctx"],
          queryFn: queryState.contextFn,
          retry: false,
        }),
      },
      ledger: {
        list: {
          queryOptions: (input: unknown) => ({
            queryKey: ["list", input],
            queryFn: queryState.listFn,
            retry: false,
          }),
        },
        messages: {
          queryOptions: (input: unknown) => ({
            queryKey: ["messages", input],
            queryFn: () => Promise.resolve([]),
            retry: false,
          }),
        },
        detail: {
          queryOptions: (input: unknown) => ({
            queryKey: ["detail", input],
            queryFn: queryState.detailFn,
            retry: false,
          }),
        },
      },
      refreshReports: {
        mutationOptions: (options: unknown) => ({
          mutationFn: () => Promise.resolve({ kind: "fresh" }),
          ...(options as object),
        }),
      },
    },
  }),
}));
vi.mock("@/hooks/use-active-organization-role", () => ({
  useActiveOrganizationRole: () => ({ role: queryState.role, isPending: false }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const configured = {
  configured: true,
  accountName: "Reviv",
  accountTimezone: "Asia/Bangkok",
  todayInAccountTz: "2026-09-10",
  lastMatchPublishedAt: "2026-09-10T01:00:00.000Z",
};

function renderPage(search = "") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <NuqsTestingAdapter searchParams={search}>
      <QueryClientProvider client={client}>
        <KlaviyoCampaignsPage />
      </QueryClientProvider>
    </NuqsTestingAdapter>,
  );
}

beforeEach(() => {
  queryState.role = "member";
  queryState.contextFn = () => Promise.resolve(configured);
});

describe("KlaviyoCampaignsPage", () => {
  it("shows the empty state for an org without the pilot and issues no ledger query", async () => {
    queryState.contextFn = () =>
      Promise.resolve({ ...configured, configured: false, accountName: null });
    const list = vi.fn(queryState.listFn);
    queryState.listFn = list;
    renderPage();
    expect(
      await screen.findByText("No Klaviyo connection for this organization"),
    ).toBeVisible();
    expect(screen.getByText(/bound to one store/)).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("gives admins the refresh button and the lab link", async () => {
    queryState.role = "admin";
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "Klaviyo campaigns" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Open lab" })).toHaveAttribute(
      "href",
      "/attribution/klaviyo",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh report" }),
      ).toBeVisible(),
    );
    expect(screen.getByText(/matches published/)).toBeVisible();
  });

  it("gives members a read-only page with the refresh hint and still opens the sheet", async () => {
    queryState.detailFn = () =>
      Promise.resolve({
        object: {
          objectId: "camp-1",
          objectType: "campaign",
          name: "July Sale",
          channel: "email",
          status: "sent",
          sentAt: "2026-07-10T09:00:00.000Z",
          subject: null,
          messageCount: 1,
        },
        klaviyo: null,
        rates: { delivered: null, open: null, click: null, unsubscribe: null },
        ours: { orderCount: 2, revenue: "97.50" },
        reconciliation: {
          unconfirmedOrders: null,
          revenuePerRecipient: null,
          averageOrderValue: "48.75",
        },
        ordersByDay: { mode: "offset", points: [] },
        topProducts: [],
        messages: [],
      });
    renderPage("?source=camp-1");
    // The open sheet is a Radix modal, so it marks the rest of the page
    // `aria-hidden`; `hidden: true` keeps these queries looking at the page
    // behind it instead of passing vacuously.
    expect(
      await screen.findByRole("heading", {
        name: "Klaviyo campaigns",
        hidden: true,
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Open lab", hidden: true }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Refresh report", hidden: true }),
    ).toBeNull();
    await waitFor(() =>
      expect(
        screen.getByText("Ask an admin to refresh the report."),
      ).toBeVisible(),
    );
    expect(
      await screen.findByRole("heading", { name: "July Sale" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "View orders in Orders →" }),
    ).toBeNull();
  });
});
