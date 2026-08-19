import { describe, expect, it } from "vitest";
import { nextChunk } from "@/lib/google-ads/facts-runner";

describe("nextChunk", () => {
  it("starts at the window start when there is no checkpoint", () => {
    expect(
      nextChunk({ windowFromDay: "2026-05-01", windowToDay: "2026-08-13", checkpointDay: null }),
    ).toEqual({ fromDay: "2026-05-01", toDay: "2026-05-14", done: false });
  });

  it("resumes after the checkpoint and clamps to the window end", () => {
    expect(
      nextChunk({ windowFromDay: "2026-05-01", windowToDay: "2026-05-20", checkpointDay: "2026-05-14" }),
    ).toEqual({ fromDay: "2026-05-15", toDay: "2026-05-20", done: true });
  });

  it("reports completion when the checkpoint reached the end", () => {
    expect(
      nextChunk({ windowFromDay: "2026-05-01", windowToDay: "2026-05-20", checkpointDay: "2026-05-20" }),
    ).toBeNull();
  });

  it("returns a single-day final chunk when the checkpoint is one day before the end", () => {
    expect(
      nextChunk({ windowFromDay: "2026-05-01", windowToDay: "2026-05-20", checkpointDay: "2026-05-19" }),
    ).toEqual({ fromDay: "2026-05-20", toDay: "2026-05-20", done: true });
  });
});
