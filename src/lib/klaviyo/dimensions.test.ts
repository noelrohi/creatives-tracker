import { describe, expect, it } from "vitest";
import {
  normalizeDimensionSnapshot,
  redactTrackingValue,
  type DimensionTraversalInput,
} from "@/lib/klaviyo/dimensions";

function traversal(
  overrides: Partial<DimensionTraversalInput> = {},
): DimensionTraversalInput {
  return {
    campaigns: [],
    campaignMessages: [],
    flows: [],
    flowActions: [],
    flowMessages: [],
    accountTrackingSettings: [],
    messageTrackingSettings: [],
    apiRevisions: { campaigns: "2026-07-15" },
    ...overrides,
  };
}

describe("normalizeDimensionSnapshot", () => {
  it("normalizes campaigns, flows, messages, and proven parent links", () => {
    const snapshot = normalizeDimensionSnapshot(
      traversal({
        campaigns: [
          {
            channel: "email",
            resource: {
              type: "campaign",
              id: "campaign-1",
              attributes: {
                name: "Summer Sale",
                status: "sent",
                created_at: "2026-07-01T00:00:00Z",
                updated_at: "2026-07-02T00:00:00Z",
              },
            },
          },
        ],
        campaignMessages: [
          {
            campaignExternalId: "campaign-1",
            resource: {
              type: "campaign-message",
              id: "message-1",
              attributes: { label: "Main Message", channel: "email" },
            },
          },
        ],
        flows: [
          {
            type: "flow",
            id: "flow-1",
            attributes: { name: "Welcome", status: "live" },
          },
        ],
        flowActions: [
          {
            flowExternalId: "flow-1",
            resource: { type: "flow-action", id: "action-1" },
          },
        ],
        flowMessages: [
          {
            flowExternalId: "flow-1",
            actionExternalId: "action-1",
            resource: {
              type: "flow-message",
              id: "flow-message-1",
              attributes: { name: "Welcome Email" },
            },
          },
        ],
      }),
    );

    const byKey = new Map(
      snapshot.objects.map((object) => [
        `${object.objectType}:${object.externalId}`,
        object,
      ]),
    );
    expect(byKey.get("campaign:campaign-1")).toMatchObject({
      name: "Summer Sale",
      channel: "email",
      status: "sent",
      parentExternalId: null,
    });
    expect(byKey.get("campaign_message:message-1")).toMatchObject({
      parentExternalId: "campaign-1",
      parentObjectType: "campaign",
      name: "Main Message",
    });
    expect(byKey.get("flow_message:flow-message-1")).toMatchObject({
      parentExternalId: "flow-1",
      parentObjectType: "flow",
    });
    expect(
      byKey.get("campaign:campaign-1")?.providerCreatedAt?.toISOString(),
    ).toBe("2026-07-01T00:00:00.000Z");
  });

  it("keeps absent relationships null and records missing parents as warnings", () => {
    const snapshot = normalizeDimensionSnapshot(
      traversal({
        campaignMessages: [
          {
            campaignExternalId: "campaign-unknown",
            resource: {
              type: "campaign-message",
              id: "message-orphan",
              attributes: { label: "Orphan" },
            },
          },
        ],
        flowMessages: [
          {
            flowExternalId: "flow-unknown",
            actionExternalId: "action-unknown",
            resource: {
              type: "flow-message",
              id: "flow-message-orphan",
              attributes: { name: "Orphan" },
            },
          },
        ],
      }),
    );
    expect(snapshot.objects).toEqual([]);
    expect(snapshot.warnings).toContain("campaign_message_parent_missing");
    expect(snapshot.warnings).toContain("flow_message_parent_missing");
  });

  it("keeps the same external ID distinct across object types", () => {
    const snapshot = normalizeDimensionSnapshot(
      traversal({
        campaigns: [
          {
            channel: "email",
            resource: {
              type: "campaign",
              id: "shared-id",
              attributes: { name: "Campaign" },
            },
          },
        ],
        flows: [
          { type: "flow", id: "shared-id", attributes: { name: "Flow" } },
        ],
      }),
    );
    expect(snapshot.objects).toHaveLength(2);
    expect(new Set(snapshot.objects.map((object) => object.objectType))).toEqual(
      new Set(["campaign", "flow"]),
    );
  });

  it("drops arbitrary response values and non-allowlisted tracking parameters", () => {
    const snapshot = normalizeDimensionSnapshot(
      traversal({
        accountTrackingSettings: [
          {
            type: "tracking-setting",
            id: "tracking-1",
            attributes: {
              utm_source: "klaviyo",
              utm_medium: "email",
              custom_parameters: [
                { name: "utm_campaign", value: "{{ campaign.name }}", dynamic: true },
                { name: "internal_secret", value: "seekrit" },
              ],
              arbitrary_blob: { email: "person@example.com" },
            },
          },
        ],
      }),
    );
    const names = snapshot.trackingSettings.map(
      (setting) => setting.parameterName,
    );
    expect(names).toEqual(
      expect.arrayContaining(["utm_source", "utm_medium", "utm_campaign"]),
    );
    expect(names).not.toContain("internal_secret");
    expect(snapshot.warnings).toContain("tracking_parameter_not_allowlisted");
    expect(JSON.stringify(snapshot)).not.toContain("person@example.com");
    expect(JSON.stringify(snapshot)).not.toContain("seekrit");
    const dynamic = snapshot.trackingSettings.find(
      (setting) => setting.parameterName === "utm_campaign",
    );
    expect(dynamic?.valueMode).toBe("dynamic");
  });

  it("never emits flow-message variation objects without a stable relationship", () => {
    const snapshot = normalizeDimensionSnapshot(traversal());
    expect(
      snapshot.objects.some(
        (object) => object.objectType === "flow_message_variation",
      ),
    ).toBe(false);
  });

  it("produces a stable checksum for identical content", () => {
    const build = () =>
      normalizeDimensionSnapshot(
        traversal({
          campaigns: [
            {
              channel: "email",
              resource: {
                type: "campaign",
                id: "campaign-1",
                attributes: { name: "Sale" },
              },
            },
          ],
        }),
      );
    expect(build().sourceChecksum).toBe(build().sourceChecksum);
    expect(build().sourceChecksum).not.toBe(
      normalizeDimensionSnapshot(traversal()).sourceChecksum,
    );
  });
});

describe("redactTrackingValue", () => {
  it("strips URL query material and rejects embedded emails", () => {
    expect(
      redactTrackingValue("https://shop.example.com/products/x?email=a@b.com"),
    ).toBe("https://shop.example.com/products/x");
    expect(redactTrackingValue("person@example.com")).toBeNull();
    expect(redactTrackingValue("{{ campaign.name }}")).toBe(
      "{{ campaign.name }}",
    );
    expect(redactTrackingValue("x".repeat(1000))).toBeNull();
  });
});
