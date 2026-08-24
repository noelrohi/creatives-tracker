import { describe, expect, it } from "vitest";
import { buildOrderJourney, type JourneyEvent } from "@/lib/klaviyo/journey";
import {
  assertExactEventSourceContract,
  consentSourceContract,
  journeySourceContract,
  orderCoreSourceContract,
} from "@/lib/klaviyo/types";

const CONVERSION = {
  eventRowId: "conversion-1",
  occurredAt: new Date("2026-07-20T10:00:00Z"),
  profileId: "profile-a",
};

function journeyEvent(overrides: Partial<JourneyEvent> = {}): JourneyEvent {
  return {
    eventRowId: "event-1",
    externalEventId: "external-1",
    metricKind: "clicked_email",
    occurredAt: new Date("2026-07-19T10:00:00Z"),
    profileId: "profile-a",
    canonicallyIngested: true,
    ...overrides,
  };
}

describe("buildOrderJourney", () => {
  it("keeps only same-profile events at or before conversion in the lookback", () => {
    const journey = buildOrderJourney({
      conversion: CONVERSION,
      attributedInteraction: null,
      profileEvents: [
        journeyEvent(),
        journeyEvent({
          eventRowId: "event-late",
          occurredAt: new Date("2026-07-20T10:00:01Z"),
        }),
        journeyEvent({
          eventRowId: "event-at-conversion",
          occurredAt: new Date("2026-07-20T10:00:00Z"),
        }),
        journeyEvent({
          eventRowId: "event-old",
          occurredAt: new Date("2026-07-01T10:00:00Z"),
        }),
      ],
      lookbackDays: 7,
      ingestedFrom: new Date("2026-05-01T00:00:00Z"),
    });
    expect(journey.label).toBe("same_klaviyo_profile");
    expect(journey.events.map((event) => event.eventRowId)).toEqual([
      "event-1",
      "event-at-conversion",
    ]);
    expect(journey.clipped).toBe(false);
    expect(journey.caveats).toContain("profile_merge_possible");
  });

  it("supports 7, 30, and 90 day lookbacks and clips to ingested coverage", () => {
    const old = journeyEvent({
      eventRowId: "event-old",
      occurredAt: new Date("2026-06-25T10:00:00Z"),
    });
    const wide = buildOrderJourney({
      conversion: CONVERSION,
      attributedInteraction: null,
      profileEvents: [old],
      lookbackDays: 30,
      ingestedFrom: new Date("2026-05-01T00:00:00Z"),
    });
    expect(wide.events).toHaveLength(1);
    const clipped = buildOrderJourney({
      conversion: CONVERSION,
      attributedInteraction: null,
      profileEvents: [old],
      lookbackDays: 90,
      ingestedFrom: new Date("2026-07-01T00:00:00Z"),
    });
    expect(clipped.clipped).toBe(true);
    expect(clipped.caveats).toContain("clipped_to_ingested_coverage");
    expect(clipped.events).toHaveLength(0);
    expect(() =>
      buildOrderJourney({
        conversion: CONVERSION,
        attributedInteraction: null,
        profileEvents: [],
        lookbackDays: 14 as 7,
        ingestedFrom: new Date(),
      }),
    ).toThrow("lookback is invalid");
  });

  it("rejects cross-profile expansion and profileless conversions", () => {
    expect(() =>
      buildOrderJourney({
        conversion: CONVERSION,
        attributedInteraction: null,
        profileEvents: [journeyEvent({ profileId: "profile-other" })],
        lookbackDays: 7,
        ingestedFrom: new Date("2026-05-01T00:00:00Z"),
      }),
    ).toThrow("exact conversion profile");
    expect(() =>
      buildOrderJourney({
        conversion: { ...CONVERSION, profileId: null },
        attributedInteraction: null,
        profileEvents: [],
        lookbackDays: 7,
        ingestedFrom: new Date(),
      }),
    ).toThrow("no profile relationship");
  });

  it("includes the attributed interaction only when canonically ingested", () => {
    const canonical = buildOrderJourney({
      conversion: CONVERSION,
      attributedInteraction: journeyEvent({ eventRowId: "interaction-1" }),
      profileEvents: [],
      lookbackDays: 7,
      ingestedFrom: new Date("2026-05-01T00:00:00Z"),
    });
    expect(canonical.events.map((event) => event.eventRowId)).toEqual([
      "interaction-1",
    ]);
    const claimOnly = buildOrderJourney({
      conversion: CONVERSION,
      attributedInteraction: journeyEvent({
        eventRowId: "interaction-2",
        canonicallyIngested: false,
      }),
      profileEvents: [],
      lookbackDays: 7,
      ingestedFrom: new Date("2026-05-01T00:00:00Z"),
    });
    expect(claimOnly.events).toHaveLength(0);
    expect(claimOnly.caveats).toContain("attributed_interaction_not_canonical");
  });

  it("deduplicates source events and orders deterministically", () => {
    const journey = buildOrderJourney({
      conversion: CONVERSION,
      attributedInteraction: journeyEvent({ eventRowId: "event-1" }),
      profileEvents: [
        journeyEvent({ eventRowId: "event-b" }),
        journeyEvent({ eventRowId: "event-a" }),
        journeyEvent({ eventRowId: "event-1" }),
      ],
      lookbackDays: 7,
      ingestedFrom: new Date("2026-05-01T00:00:00Z"),
    });
    expect(journey.events.map((event) => event.eventRowId)).toEqual([
      "event-1",
      "event-a",
      "event-b",
    ]);
  });
});

describe("event source contract union", () => {
  it("accepts both closed contracts and rejects drift", () => {
    expect(() =>
      assertExactEventSourceContract(orderCoreSourceContract()),
    ).not.toThrow();
    expect(() =>
      assertExactEventSourceContract(journeySourceContract()),
    ).not.toThrow();
    expect(() =>
      assertExactEventSourceContract({
        sourceMode: "journey",
        metricKinds: ["clicked_email"],
      }),
    ).toThrow("invalid source contract");
    expect(() =>
      assertExactEventSourceContract({
        sourceMode: "order_core",
        metricKinds: [
          "clicked_email",
          "clicked_sms",
          "active_on_site",
          "viewed_product",
          "added_to_cart",
          "checkout_started",
        ],
      }),
    ).toThrow("invalid source contract");
    expect(() =>
      assertExactEventSourceContract({
        ...journeySourceContract(),
        extra: 1,
      }),
    ).toThrow("not an immutable source contract");
  });
});

describe("consent source contract", () => {
  it("builds the fixed two-kind contract", () => {
    expect(consentSourceContract()).toEqual({
      sourceMode: "consent",
      metricKinds: ["subscribed_to_list", "unsubscribed_from_list"],
    });
  });

  it("accepts only the exact consent shape", () => {
    expect(() =>
      assertExactEventSourceContract(consentSourceContract()),
    ).not.toThrow();
    expect(() =>
      assertExactEventSourceContract({
        sourceMode: "consent",
        metricKinds: ["unsubscribed_from_list", "subscribed_to_list"],
      }),
    ).toThrow("invalid source contract");
    expect(() =>
      assertExactEventSourceContract({
        sourceMode: "consent",
        metricKinds: ["subscribed_to_list", "unsubscribed_from_list"],
        extra: 1,
      }),
    ).toThrow();
  });
});
