# Issues 257–261 implementation plan

Approved design: `../specs/2026-09-06-analytics-reporting-contracts-design.md`.

1. #259: add closed conversions/ROAS ordering to the top SQL before LIMIT, stable unique ties to all lists, typed per-list algorithm metadata and OpenAPI descriptions. Extend caller/SQL regressions; verify typecheck.
2. #257: resolve database calendar bounds once, reuse in dashboard SQL and metadata; add explicit source-calendar evidence to attribution aggregates. Test precedence, database-calendar defaults, DST and mixed/unknown timezones.
3. #258: load org-scoped per-account sync evidence without secrets; classify freshness independently from unknown coverage and provisional reporting. Preserve existing health. Test missing, failed, disconnected and lagging accounts and output contracts.
4. #260: verify authoritative Shopify status semantics and write the separate fulfillment spec. Add nullable observed status, migration, ingest/upsert support and aggregate-only read endpoint after spec approval. Test status, cancellations, dates, later updates and isolation; document backfill/access limitations.
5. #261: inspect primary API documentation and current integration assumptions; publish a discovery decision record with access blockers or feasibility, metric definition and cost. No implementation or credential changes.
6. Run targeted Vitest suites, typecheck, lint and the full suite; review diff against issue acceptance criteria. Report unrun checks and remaining work explicitly.

Use Bun. Do not run production migrations/backfills, change credentials or deploy. Do not claim SQL behavior is proven merely by returning presorted mocked fixtures.

## Progress and verification (2026-09-06)

- #257–259 implemented: shared range/evidence contracts, database-resolved dashboard bounds, per-account source state, top sorting and per-list algorithm metadata; existing fields retained.
- PostgreSQL fixtures prove full-population sorting before LIMIT, ties, eligibility thresholds, status/other filters, lifetime scope, read-key/org isolation and database-calendar resolution. Caller/unit tests cover source evidence, DST dates and generated OpenAPI contracts.
- #261 discovery record: `docs/specs/2026-09-06-shopify-conversion-rate-discovery.md`. An authoritative ShopifyQL source exists; installed access/calendar validation remains unverified. No endpoint or authenticated probe.
- #260 approved and implemented: nullable source status/observation migration `0071_exotic_epoch`, guarded ingestion, aggregate-only read query and bounded operator backfill. See `docs/specs/2026-09-06-shopify-unfulfilled-orders.md` for status rules and execution instructions. No production migration/backfill/deployment.
- Full suite after #260: 124 files / 1,866 tests passed using disposable local PostgreSQL on port 55439 with UTC database timezone. Initial default-local-timezone lease test failures passed after configuring the disposable cluster to UTC; no application changes for those tests.
- `bun run typecheck` passed. Repository lint passed with nine existing warnings outside changed code. `git diff --check` passed.
- Review scope: work-in-progress diff against `1813fc8`, including new files. Standards pass: no outstanding defects found; no secrets, dependency updates or production writes. Requirements pass: #257–259 implemented and #261 discovery delivered. Follow-up #260 review against `5a70a38`: no outstanding standards/requirements defects found; PostgreSQL tests cover generated migration, every status, cancellations, legacy/unknown coverage, midnight/DST, historical changes and stale updates, backfill resume/binding and read-key/org isolation. Changed-file lint, typecheck and migration-chain validation pass.
