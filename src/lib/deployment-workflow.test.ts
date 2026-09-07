import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`Missing deployment job ${name}`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("production release ordering", () => {
  it("runs snapshot integration tests against the explicit disposable CI database", () => {
    expect(job("test")).toContain("POSTGRES_DB: snapshot_ci");
    expect(job("test")).toContain("DATABASE_URL: postgres://ci:ci@localhost:5432/snapshot_ci");
    expect(job("test")).toContain('SNAPSHOT_TEST_DATABASE: "1"');
    expect(job("test")).toContain("TZ: UTC");
  });

  it("migrates only on main after checks, using the production app configuration", () => {
    const migration = job("migrate");
    expect(migration).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(migration).toContain("needs: [static, test, components]");
    const pull = migration.indexOf("vercel pull --yes --environment=production");
    const apply = migration.indexOf("bun --env-file=.vercel/.env.production.local run db:migrate");
    expect(pull).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(pull);
    expect(migration).not.toContain("db:push");
    expect(migration).not.toContain("cat .vercel");
  });

  it("blocks worker deployment on migration and web deployment on both", () => {
    expect(job("trigger-deploy")).toContain("needs: [static, test, components, migrate]");
    expect(job("deploy")).toContain("needs: [static, test, components, migrate, trigger-deploy]");
    expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });
});
