import { describe, expect, it } from "vitest";
import {
  isEffectivelyActive,
  resolveEffectiveAdStatus,
} from "./effective-ad-status";
import { computeHealth, rollupCreativeHealth } from "./creative-health";

describe("effective ad status", () => {
  it("keeps active ads active only when the parent ad set can deliver", () => {
    expect(resolveEffectiveAdStatus({ adStatus: "active", adSetStatus: "active" })).toBe("active");
    expect(resolveEffectiveAdStatus({ adStatus: "active", adSetStatus: null })).toBe("active");
    expect(resolveEffectiveAdStatus({ adStatus: "active", adSetStatus: "paused" })).toBe("paused");
    expect(resolveEffectiveAdStatus({ adStatus: "active", adSetStatus: "archived" })).toBe("paused");
  });

  it("does not let ad set status mask the ad's own terminal status", () => {
    expect(resolveEffectiveAdStatus({ adStatus: "paused", adSetStatus: "active" })).toBe("paused");
    expect(resolveEffectiveAdStatus({ adStatus: "paused", adSetStatus: "paused" })).toBe("paused");
    expect(resolveEffectiveAdStatus({ adStatus: "archived", adSetStatus: "paused" })).toBe("archived");
  });

  it("derives active-ness from both ad and ad set", () => {
    expect(isEffectivelyActive({ adStatus: "active", adSetStatus: "active" })).toBe(true);
    expect(isEffectivelyActive({ adStatus: "active", adSetStatus: "paused" })).toBe(false);
    expect(isEffectivelyActive({ adStatus: "paused", adSetStatus: "active" })).toBe(false);
  });
});

describe("media-buyer actionability regressions", () => {
  it("does not call an active ad actionable when its ad set is paused", () => {
    const status = resolveEffectiveAdStatus({
      adStatus: "active",
      adSetStatus: "paused",
    });

    const verdict = computeHealth({
      roas: null,
      spend: 100,
      conversions: 0,
      status,
    });

    expect(status).toBe("paused");
    expect(verdict).toEqual({ health: null, reasons: [] });
  });

  it("still flags a no-conversion active ad when both ad and ad set are active", () => {
    const status = resolveEffectiveAdStatus({
      adStatus: "active",
      adSetStatus: "active",
    });

    expect(computeHealth({
      roas: null,
      spend: 100,
      conversions: 0,
      status,
    })).toMatchObject({
      health: "critical",
      reasons: ["No conversions on $100 spent"],
    });
  });

  it("excludes paused-parent ads from creative rollups so historical losers do not pollute live action", () => {
    const pausedByParent = resolveEffectiveAdStatus({
      adStatus: "active",
      adSetStatus: "paused",
    });

    expect(rollupCreativeHealth([
      {
        spend: 250,
        health: "critical",
        reasons: ["No conversions on $250 spent"],
        status: pausedByParent,
      },
    ])).toEqual({ health: null, reasons: [] });
  });

  it("keeps active-parent ads in creative rollups", () => {
    const active = resolveEffectiveAdStatus({
      adStatus: "active",
      adSetStatus: "active",
    });

    expect(rollupCreativeHealth([
      {
        spend: 250,
        health: "critical",
        reasons: ["No conversions on $250 spent"],
        status: active,
      },
    ])).toMatchObject({ health: "critical" });
  });
});
