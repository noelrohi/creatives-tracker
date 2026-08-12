import { describe, expect, it, vi } from "vitest";
import { uninstallKlaviyoConnection } from "@/lib/klaviyo/connection-lifecycle";

describe("uninstallKlaviyoConnection", () => {
  it("clears pilot Shopify identity and deletes the connection in one transaction", async () => {
    const calls: string[] = [];
    const transaction = vi.fn(async (work: (tx: never) => Promise<void>) => {
      calls.push("transaction:start");
      await work({} as never);
      calls.push("transaction:commit");
    });
    const lockStore = vi.fn(async () => {
      calls.push("store:lock");
      return true;
    });
    const loadConnection = vi.fn(async () => {
      calls.push("connection:lock");
      return {
        organizationId: "org-1",
        storeId: "store-1",
        connectionId: "connection-1",
      };
    });
    const clearIdentity = vi.fn(async () => {
      calls.push("identity:clear");
      return { ordersCleared: 2, digestsDeleted: 2 };
    });
    const deleteConnection = vi.fn(async () => {
      calls.push("connection:delete");
      return 1;
    });

    await expect(
      uninstallKlaviyoConnection(
        {
          organizationId: "org-1",
          storeId: "store-1",
          connectionId: "connection-1",
        },
        {
          transaction,
          lockStore,
          loadConnection,
          clearIdentity,
          deleteConnection,
        },
      ),
    ).resolves.toEqual({
      shopifyIdentity: { ordersCleared: 2, digestsDeleted: 2 },
    });
    expect(calls).toEqual([
      "transaction:start",
      "store:lock",
      "connection:lock",
      "identity:clear",
      "connection:delete",
      "transaction:commit",
    ]);
  });

  it("fails without deleting anything when the scoped connection is absent", async () => {
    const deleteConnection = vi.fn();
    await expect(
      uninstallKlaviyoConnection(
        {
          organizationId: "org-1",
          storeId: "store-1",
          connectionId: "missing",
        },
        {
          transaction: async (work) => work({} as never),
          lockStore: async () => true,
          loadConnection: async () => null,
          clearIdentity: vi.fn(),
          deleteConnection,
        },
      ),
    ).rejects.toThrow("Klaviyo connection not found in this scope");
    expect(deleteConnection).not.toHaveBeenCalled();
  });

  it("fails before connection or identity mutation when the scoped store is absent", async () => {
    const loadConnection = vi.fn();
    const clearIdentity = vi.fn();
    const deleteConnection = vi.fn();
    await expect(
      uninstallKlaviyoConnection(
        {
          organizationId: "org-1",
          storeId: "missing-store",
          connectionId: "connection-1",
        },
        {
          transaction: async (work) => work({} as never),
          lockStore: async () => false,
          loadConnection,
          clearIdentity,
          deleteConnection,
        },
      ),
    ).rejects.toThrow("Shopify store not found in this scope");
    expect(loadConnection).not.toHaveBeenCalled();
    expect(clearIdentity).not.toHaveBeenCalled();
    expect(deleteConnection).not.toHaveBeenCalled();
  });

  it("rolls back when the connection delete conflicts", async () => {
    let committed = false;
    await expect(
      uninstallKlaviyoConnection(
        {
          organizationId: "org-1",
          storeId: "store-1",
          connectionId: "connection-1",
        },
        {
          transaction: async (work) => {
            await work({} as never);
            committed = true;
          },
          lockStore: async () => true,
          loadConnection: async () => ({
            organizationId: "org-1",
            storeId: "store-1",
            connectionId: "connection-1",
          }),
          clearIdentity: async () => ({ ordersCleared: 1, digestsDeleted: 1 }),
          deleteConnection: async () => 0,
        },
      ),
    ).rejects.toThrow("Klaviyo connection uninstall conflicted");
    expect(committed).toBe(false);
  });
});
