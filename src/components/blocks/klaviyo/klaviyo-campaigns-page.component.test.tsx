import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KlaviyoCampaignsPage } from "./klaviyo-campaigns-page";

const defaultListFn = (): Promise<unknown> =>
  Promise.resolve({
    rows: [],
    report: {
      asOf: null,
      hasCampaignGeneration: false,
      hasFlowGeneration: false,
    },
  });

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
  role: "member" as "member" | "admin" | "owner" | null,
  rolePending: false,
}));

const nav = vi.hoisted(() => ({ push: vi.fn() }));

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
  useActiveOrganizationRole: () => ({
    role: queryState.role,
    isPending: queryState.rolePending,
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const configured = {
  configured: true,
  accountName: "Reviv",
  accountTimezone: "Asia/Bangkok",
  todayInAccountTz: "2026-09-10",
  lastMatchPublishedAt: "2026-09-10T01:00:00.000Z",
};

/** One sent campaign or flow, shaped like `klaviyo.ledger.detail` returns it. */
function detailFixture(
  object: {
    objectId: string;
    objectType: "campaign" | "flow";
    name: string;
    sentAt: string | null;
  },
) {
  return {
    object: { ...object, channel: "email", status: "sent", subject: null, messageCount: 1 },
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
  };
}

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
  queryState.rolePending = false;
  queryState.contextFn = () => Promise.resolve(configured);
  queryState.listFn = defaultListFn;
  nav.push.mockClear();
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
      Promise.resolve(
        detailFixture({
          objectId: "camp-1",
          objectType: "campaign",
          name: "July Sale",
          sentAt: "2026-07-10T09:00:00.000Z",
        }),
      );
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

  it("shows members the ledger rows without a Refresh button", async () => {
    queryState.listFn = () =>
      Promise.resolve({
        rows: [
          {
            objectId: "camp-1",
            objectType: "campaign",
            name: "July Sale",
            channel: "email",
            status: "sent",
            sentAt: "2026-07-10T09:00:00.000Z",
            messageCount: 1,
            klaviyo: {
              recipients: 1000,
              delivered: 990,
              uniqueOpens: 400,
              uniqueClicks: 40,
              bounced: 10,
              unsubscribes: 2,
              spamComplaints: 0,
              conversions: 5,
              conversionValue: "150.00",
            },
            rates: { delivered: 0.99, open: 0.4, click: 0.04, unsubscribe: 0.002 },
            orderCount: 3,
            revenue: "97.50",
          },
        ],
        report: {
          asOf: "2026-08-02T00:00:00.000Z",
          hasCampaignGeneration: true,
          hasFlowGeneration: true,
        },
      });
    renderPage();
    expect(await screen.findByText("July Sale")).toBeVisible();
    expect(screen.getByText("$97.50")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Refresh report" }),
    ).toBeNull();
  });

  it("sends an admin from a campaign to its orders starting at the send day", async () => {
    queryState.role = "admin";
    queryState.detailFn = () =>
      Promise.resolve(
        detailFixture({
          objectId: "camp-1",
          objectType: "campaign",
          name: "July Sale",
          sentAt: "2026-07-10T09:00:00.000Z",
        }),
      );
    renderPage("?source=camp-1");
    await userEvent.click(
      await screen.findByRole("button", { name: "View orders in Orders →" }),
    );
    // A campaign's orders outlive the ledger window, so the send day is a
    // range START with no end.
    expect(nav.push).toHaveBeenCalledExactlyOnceWith(
      "/attribution/klaviyo?view=orders&source=camp-1&range=custom&from=2026-07-10",
    );
  });

  it("sends an admin from a flow to its orders across the shown range", async () => {
    queryState.role = "admin";
    queryState.detailFn = () =>
      Promise.resolve(
        detailFixture({
          objectId: "flow-1",
          objectType: "flow",
          name: "Welcome series",
          sentAt: null,
        }),
      );
    renderPage("?source=flow-1");
    await userEvent.click(
      await screen.findByRole("button", { name: "View orders in Orders →" }),
    );
    // A flow never "sent" on a day, so the orders view keeps the range the
    // ledger is showing — the default last30 ending on the account's today.
    expect(nav.push).toHaveBeenCalledExactlyOnceWith(
      "/attribution/klaviyo?view=orders&source=flow-1&range=custom&from=2026-08-12&to=2026-09-10",
    );
  });

  it("shows neither the admin controls nor the member hint while the role is pending", async () => {
    queryState.role = null;
    queryState.rolePending = true;
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "Klaviyo campaigns" }),
    ).toBeVisible();
    expect(await screen.findByText("No report for this range yet")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Refresh report" }),
    ).toBeNull();
    expect(screen.queryByText("Ask an admin to refresh the report.")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open lab" })).toBeNull();
  });

  it("shows the error state with a Retry button when the context query fails", async () => {
    queryState.contextFn = () => Promise.reject(new Error("boom"));
    renderPage();
    expect(await screen.findByText("Couldn’t load Klaviyo.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});
