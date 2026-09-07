/** Test-only DDL generated from the snapshot schema, including its real constraints. */
import type { Pool } from "pg";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import * as snapshots from "@/schema/klaviyo-snapshot";

export async function applySnapshotPrivacyFixture(pool: Pool): Promise<void> {
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(snapshots),
  );
  for (const statement of statements) await pool.query(statement);
}
