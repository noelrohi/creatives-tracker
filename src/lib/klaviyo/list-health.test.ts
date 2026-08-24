import { describe, expect, it } from "vitest";
import { computeListHealth } from "@/lib/klaviyo/list-health";

const TZ = "Asia/Bangkok";
const window = {
  from: new Date("2026-08-01T00:00:00.000Z"),
  to: new Date("2026-08-15T00:00:00.000Z"),
};
const ev = (
  profileId: string,
  kind: "subscribed_to_list" | "unsubscribed_from_list",
  iso: string,
) => ({ profileId, metricKind: kind, occurredAt: new Date(iso) });

describe("computeListHealth", () => {
  it("counts subscribes and unsubscribes inside the window only", () => {
    const result = computeListHealth(
      [
        ev("p1", "subscribed_to_list", "2026-08-02T10:00:00Z"),
        ev("p2", "unsubscribed_from_list", "2026-08-03T10:00:00Z"),
        ev("p3", "subscribed_to_list", "2026-07-20T10:00:00Z"), // before window
        ev("p4", "subscribed_to_list", "2026-08-15T00:00:00Z"), // at exclusive end
      ],
      { window, timeZone: TZ },
    );
    expect(result.totals).toEqual({
      subscribed: 1,
      unsubscribed: 1,
      wonBack: 0,
      quickChurn: 0,
      net: 0,
    });
  });

  it("counts won-back when the previous consent event is an unsubscribe, including history before the window", () => {
    const result = computeListHealth(
      [
        ev("p1", "unsubscribed_from_list", "2026-07-10T10:00:00Z"),
        ev("p1", "subscribed_to_list", "2026-08-05T10:00:00Z"),
      ],
      { window, timeZone: TZ },
    );
    expect(result.totals.wonBack).toBe(1);
    expect(result.totals.subscribed).toBe(1);
    expect(result.daily).toEqual([
      { day: "2026-08-05", subscribed: 1, unsubscribed: 0, wonBack: 1, quickChurn: 0, net: 1 },
    ]);
  });

  it("never counts a first-ever event as won-back or quick churn", () => {
    const result = computeListHealth(
      [ev("p1", "unsubscribed_from_list", "2026-08-05T10:00:00Z")],
      { window, timeZone: TZ },
    );
    expect(result.totals).toMatchObject({ unsubscribed: 1, wonBack: 0, quickChurn: 0 });
  });

  it("counts quick churn only within 14x24h of the previous subscribe", () => {
    const result = computeListHealth(
      [
        ev("p1", "subscribed_to_list", "2026-07-25T10:00:00Z"),
        ev("p1", "unsubscribed_from_list", "2026-08-08T09:59:00Z"), // 13d23h59m later
        ev("p2", "subscribed_to_list", "2026-07-25T10:00:00Z"),
        ev("p2", "unsubscribed_from_list", "2026-08-08T10:01:00Z"), // 14d + 1m later
      ],
      { window, timeZone: TZ },
    );
    expect(result.totals.quickChurn).toBe(1);
    expect(result.totals.unsubscribed).toBe(2);
  });

  it("buckets days in the store timezone", () => {
    // 2026-08-04T18:00:00Z is 2026-08-05 01:00 in Asia/Bangkok (+7).
    const result = computeListHealth(
      [ev("p1", "subscribed_to_list", "2026-08-04T18:00:00Z")],
      { window, timeZone: TZ },
    );
    expect(result.daily).toEqual([
      { day: "2026-08-05", subscribed: 1, unsubscribed: 0, wonBack: 0, quickChurn: 0, net: 1 },
    ]);
  });

  it("derives net and orders daily rows descending by day", () => {
    const result = computeListHealth(
      [
        ev("p1", "subscribed_to_list", "2026-08-02T10:00:00Z"),
        ev("p2", "subscribed_to_list", "2026-08-02T11:00:00Z"),
        ev("p3", "unsubscribed_from_list", "2026-08-04T10:00:00Z"),
      ],
      { window, timeZone: TZ },
    );
    expect(result.totals.net).toBe(1);
    expect(result.daily.map((row) => row.day)).toEqual(["2026-08-04", "2026-08-02"]);
  });

  it("counts one event per list membership — two same-kind events for one profile count twice", () => {
    // v1 stores no list identity: a person subscribing on two lists emits
    // two events and counts as 2, matching Klaviyo's own list numbers.
    const result = computeListHealth(
      [
        ev("p1", "subscribed_to_list", "2026-08-02T10:00:00Z"),
        ev("p1", "subscribed_to_list", "2026-08-02T10:05:00Z"),
      ],
      { window, timeZone: TZ },
    );
    expect(result.totals.subscribed).toBe(2);
    expect(result.totals.wonBack).toBe(0);
  });

  it("ignores event insertion order — occurred_at decides prior state", () => {
    const shuffled = [
      ev("p1", "subscribed_to_list", "2026-08-05T10:00:00Z"),
      ev("p1", "unsubscribed_from_list", "2026-07-10T10:00:00Z"),
    ];
    expect(computeListHealth(shuffled, { window, timeZone: TZ }).totals.wonBack).toBe(1);
  });

  it("treats every profile-less event as its own singleton sequence — no phantom flip from a same-instant pair", () => {
    const result = computeListHealth(
      [
        { profileId: null, metricKind: "unsubscribed_from_list", occurredAt: new Date("2026-08-05T10:00:00Z") },
        { profileId: null, metricKind: "subscribed_to_list", occurredAt: new Date("2026-08-05T10:00:00Z") },
      ],
      { window, timeZone: TZ },
    );
    expect(result.totals).toEqual({
      subscribed: 1,
      unsubscribed: 1,
      wonBack: 0,
      quickChurn: 0,
      net: 0,
    });
  });

  it("returns zero totals and empty daily rows for no events", () => {
    const result = computeListHealth([], { window, timeZone: TZ });
    expect(result.totals).toEqual({
      subscribed: 0,
      unsubscribed: 0,
      wonBack: 0,
      quickChurn: 0,
      net: 0,
    });
    expect(result.daily).toEqual([]);
  });
});
