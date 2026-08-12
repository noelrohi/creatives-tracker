import { sql } from "drizzle-orm";
import { db } from "@/db";
import { formatDateOnly } from "@/lib/date";
import { listRetentionOrganizationIds, planRetention } from "@/lib/retention/plan";
import { redactOrganizationId } from "@/lib/retention/policy";

type StorageRow = {
  database_bytes: string | number;
  total_bytes: string | number;
  heap_bytes: string | number;
  index_bytes: string | number;
  live_rows: string | number;
};

type ReportCategory = {
  category: string;
  table: string;
  candidateRows: number;
  oldestDate: string | null;
  newestDate: string | null;
  // Bytes are only estimable for performance_log (its live-row density is
  // measured); evidence tables report null rather than a borrowed density.
  estimatedSizeBytes: number | null;
};

type OrganizationReport = {
  organizationId: string;
  today: string;
  cutoffs: { base: string; breakdown: string; evidence: string };
  categories: ReportCategory[];
  totalCandidateRows: number;
  estimatedSizeBytes: number;
  databaseSizeBeforeBytes: number;
  estimatedLogicalSizeAfterBytes: number;
};

function numberValue(value: string | number | undefined) {
  return Number(value ?? 0);
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${formatInteger(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const nextUnit of units) {
    value /= 1024;
    unit = nextUnit;
    if (value < 1024) break;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function printTable(rows: string[][]) {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  for (const [index, row] of rows.entries()) {
    console.log(
      row
        .map((cell, column) => cell.padEnd(widths[column]))
        .join(" | ")
        .trimEnd(),
    );
    if (index === 0) {
      console.log(widths.map((width) => "-".repeat(width)).join("-+-"));
    }
  }
}

async function buildReport() {
  const [organizationIds, storageResult] = await Promise.all([
    listRetentionOrganizationIds(),
    db.execute(sql`
      SELECT
        pg_database_size(current_database())::bigint AS database_bytes,
        pg_total_relation_size('performance_log')::bigint AS total_bytes,
        pg_relation_size('performance_log')::bigint AS heap_bytes,
        pg_indexes_size('performance_log')::bigint AS index_bytes,
        COALESCE(
          (SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'performance_log'),
          0
        )::bigint AS live_rows
    `),
  ]);

  const storage = (storageResult.rows[0] ?? {}) as StorageRow;
  const databaseSizeBytes = numberValue(storage.database_bytes);
  const performanceLogSizeBytes = numberValue(storage.total_bytes);
  const liveRows = numberValue(storage.live_rows);
  const estimatedBytesPerRow = performanceLogSizeBytes / Math.max(liveRows, 1);
  const today = formatDateOnly(new Date());
  const organizations: OrganizationReport[] = [];

  for (const organizationId of organizationIds) {
    const plan = await planRetention({ organizationId, today });
    const categories = plan.categories.map((category) => ({
      category: category.cascadeOnly ? `${category.key} (cascade)` : category.key,
      table: category.table,
      candidateRows: category.candidateRows,
      oldestDate: category.oldestDate,
      newestDate: category.newestDate,
      estimatedSizeBytes:
        category.table === "performance_log"
          ? Math.round(category.candidateRows * estimatedBytesPerRow)
          : null,
    }));
    const estimatedSizeBytes = categories.reduce(
      (total, category) => total + (category.estimatedSizeBytes ?? 0),
      0,
    );

    organizations.push({
      organizationId: redactOrganizationId(organizationId),
      today: plan.today,
      cutoffs: plan.cutoffs,
      categories,
      totalCandidateRows: plan.totalCandidateRows,
      estimatedSizeBytes,
      databaseSizeBeforeBytes: databaseSizeBytes,
      estimatedLogicalSizeAfterBytes: Math.max(
        databaseSizeBytes - estimatedSizeBytes,
        0,
      ),
    });
  }

  return {
    generatedForDate: today,
    performanceLog: {
      totalBytes: performanceLogSizeBytes,
      heapBytes: numberValue(storage.heap_bytes),
      indexBytes: numberValue(storage.index_bytes),
      liveRowEstimate: liveRows,
      estimatedBytesPerRow,
    },
    organizations,
  };
}

function printHuman(report: Awaited<ReturnType<typeof buildReport>>) {
  console.log(`Retention report for ${report.generatedForDate}`);
  console.log(
    `performance_log: ${formatBytes(report.performanceLog.totalBytes)} total ` +
      `(${formatBytes(report.performanceLog.heapBytes)} heap, ` +
      `${formatBytes(report.performanceLog.indexBytes)} indexes), ` +
      `${formatInteger(report.performanceLog.liveRowEstimate)} estimated live rows`,
  );

  if (report.organizations.length === 0) {
    console.log("No organizations found in performance_log.");
    return;
  }

  for (const organization of report.organizations) {
    console.log(`\nOrganization ${organization.organizationId}`);
    console.log(
      `Cutoffs: base ${organization.cutoffs.base}; breakdown ${organization.cutoffs.breakdown}; evidence ${organization.cutoffs.evidence}`,
    );
    printTable([
      ["category", "candidate rows", "oldest", "newest", "est. size"],
      ...organization.categories.map((category) => [
        category.category,
        formatInteger(category.candidateRows),
        category.oldestDate ?? "—",
        category.newestDate ?? "—",
        category.estimatedSizeBytes === null
          ? "n/a"
          : formatBytes(category.estimatedSizeBytes),
      ]),
      [
        "total",
        formatInteger(organization.totalCandidateRows),
        "",
        "",
        formatBytes(organization.estimatedSizeBytes),
      ],
    ]);
    console.log(
      `Database size before: ${formatBytes(organization.databaseSizeBeforeBytes)}`,
    );
    console.log(
      `Estimated logical size after: ${formatBytes(organization.estimatedLogicalSizeAfterBytes)}`,
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((argument) => argument !== "--json");
  if (unknown.length > 0) {
    throw new Error(`Unknown option: ${unknown[0]}`);
  }

  const report = await buildReport();
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Retention report failed: ${message.replace(/\s+/g, " ").trim()}`);
  process.exitCode = 1;
});
