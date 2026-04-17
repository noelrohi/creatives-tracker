import { sql, type SQL } from "drizzle-orm";

const BREAKDOWN_COLUMNS = [
  "country",
  "platform",
  "placement",
  "device",
  "age",
  "gender",
] as const;

function qualifiedColumn(alias: string, column: (typeof BREAKDOWN_COLUMNS)[number]): SQL {
  return sql.raw(`${alias}.${column}`);
}

export function basePerformanceLogFilter(alias = "pl"): SQL {
  return sql.join(
    BREAKDOWN_COLUMNS.map((column) => sql`coalesce(${qualifiedColumn(alias, column)}, '') = ''`),
    sql` AND `,
  );
}
