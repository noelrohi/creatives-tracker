import { afterEach, describe, expect, it } from "vitest";
import {
  createApiKeyCaller,
  createMockCaller,
} from "../test-helpers";

const previousPublishFlag = process.env.ADSOLUTE_META_PUBLISH_ENABLED;

afterEach(() => {
  if (previousPublishFlag === undefined) {
    delete process.env.ADSOLUTE_META_PUBLISH_ENABLED;
  } else {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = previousPublishFlag;
  }
});

describe("launchpad router safety", () => {
  it("blocks ordinary members from the Launchpad ledger surface", async () => {
    const memberCaller = createMockCaller({ role: "member" });

    await expect(memberCaller.launchpad.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      memberCaller.launchpad.createValidationRun({
        idempotencyKey: "member-demo-key",
        items: [{ adName: "Member demo" }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("blocks API keys from requesting live publishing", async () => {
    const apiKeyCaller = createApiKeyCaller();

    await expect(
      apiKeyCaller.launchpad.requestLivePublish({
        runId: "run-1",
        confirmation: "PUBLISH_PAUSED_META_ADS",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns an env-disabled rejection shape before any live publish path", async () => {
    process.env.ADSOLUTE_META_PUBLISH_ENABLED = "false";
    const adminCaller = createMockCaller({ role: "admin" });

    await expect(
      adminCaller.launchpad.requestLivePublish({
        runId: "run-1",
        confirmation: "PUBLISH_PAUSED_META_ADS",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("ADSOLUTE_META_PUBLISH_ENABLED"),
    });
  });
});
