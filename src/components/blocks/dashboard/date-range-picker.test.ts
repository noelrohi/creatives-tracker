import { format } from "date-fns";
import { describe, expect, it } from "vitest";
import { datePresets } from "./date-range-picker";

const day = (date: Date) => format(date, "yyyy-MM-dd");

describe("datePresets", () => {
  // A local-time "today" at an arbitrary hour: presets are calendar days.
  const today = new Date(2026, 8, 9, 15, 45);
  const byLabel = new Map(datePresets(today).map((p) => [p.label, p.range]));

  it("anchors every preset on the supplied today, not the browser's", () => {
    expect(day(byLabel.get("Today")!.from)).toBe("2026-09-09");
    expect(day(byLabel.get("Today")!.to)).toBe("2026-09-09");
    expect(day(byLabel.get("Yesterday")!.from)).toBe("2026-09-08");
    expect(day(byLabel.get("Yesterday")!.to)).toBe("2026-09-08");
    expect(day(byLabel.get("Last 7 days")!.from)).toBe("2026-09-03");
    expect(day(byLabel.get("Last 30 days")!.from)).toBe("2026-08-11");
    expect(day(byLabel.get("This month")!.from)).toBe("2026-09-01");
    expect(day(byLabel.get("Last Month")!.from)).toBe("2026-08-01");
    expect(day(byLabel.get("Last Month")!.to)).toBe("2026-08-31");
    expect(day(byLabel.get("Last 3 Months")!.from)).toBe("2026-06-01");
    expect(day(byLabel.get("Last 3 Months")!.to)).toBe("2026-08-31");
  });

  it("differs when the active timezone's today is a day ahead of the browser", () => {
    // A Melbourne store already on 09-10 while a Los Angeles browser is on
    // 09-09: "Yesterday" must be the store's 09-09, not the browser's 09-08.
    const melbourneToday = new Date(2026, 8, 10);
    const yesterday = datePresets(melbourneToday).find((p) => p.label === "Yesterday")!;
    expect(day(yesterday.range.from)).toBe("2026-09-09");
  });
});
