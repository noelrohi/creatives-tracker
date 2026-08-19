import { eq } from "drizzle-orm";
import { metadata, tags, task } from "@trigger.dev/sdk";
import { db } from "@/db";
import { gclidProbeReports } from "@/schema/google-ads";
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

function orgTag(organizationId: string) {
  return `gclid-probe:org:${organizationId}`;
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
    const [report] = await db
      .select({ organizationId: gclidProbeReports.organizationId })
      .from(gclidProbeReports)
      .where(eq(gclidProbeReports.id, payload.probeReportId))
      .limit(1);
    if (!report) throw new Error("gclid probe report does not exist");
    await tags.add(orgTag(report.organizationId));
    metadata.set("status", "scanning");
    const summary = await runGclidProbe({ probeReportId: payload.probeReportId });
    metadata.set("ordersScanned", summary.ordersScanned);
    metadata.set("status", "completed");
    return {
      ordersScanned: summary.ordersScanned,
      ordersWithAnyClickId: summary.ordersWithAnyClickId,
    };
  },
});
