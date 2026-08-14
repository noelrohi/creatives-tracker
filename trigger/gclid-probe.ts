import { metadata, tags, task } from "@trigger.dev/sdk";
import {
  failGclidProbeReport,
  runGclidProbe,
} from "@/lib/google-ads/gclid-probe";
import { KLAVIYO_TASK_RETRY } from "./retry";

type ProbePayload = { probeReportId: string };

function assertExactProbePayload(value: unknown): asserts value is ProbePayload {
  const input = value as Record<string, unknown> | null;
  if (
    !input ||
    typeof input.probeReportId !== "string" ||
    input.probeReportId.length === 0 ||
    Object.keys(input).length !== 1
  ) {
    throw new Error("gclid probe task accepts only a probe report ID");
  }
}

export const gclidProbeTask = task({
  id: "gclid-probe",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 600,
  queue: { name: "gclid-probe", concurrencyLimit: 1 },
  onFailure: async ({ payload }) => {
    assertExactProbePayload(payload);
    await failGclidProbeReport({
      probeReportId: payload.probeReportId,
      code: "retry_exhausted",
      message: "gclid probe retries were exhausted",
    });
  },
  run: async (payload: ProbePayload) => {
    assertExactProbePayload(payload);
    metadata.set("status", "scanning");
    const summary = await runGclidProbe({ probeReportId: payload.probeReportId });
    await tags.add(`gclid-probe:orders:${summary.ordersScanned}`);
    metadata.set("status", "completed");
    return {
      ordersScanned: summary.ordersScanned,
      ordersWithAnyClickId: summary.ordersWithAnyClickId,
    };
  },
});
