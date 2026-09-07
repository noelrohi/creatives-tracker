# Klaviyo snapshot operations

The four `/api/openapi/klaviyoReads/` GETs read published Postgres snapshots only. They never contact Klaviyo or queue work. See the [design](superpowers/specs/2026-09-07-klaviyo-postgres-snapshots-design.md) and [parity matrix](klaviyo-parity-matrix.md).

## Release

On a checked `main` push, GitHub Actions applies generated Drizzle migrations using the explicitly authorized `PRODUCTION_DATABASE_URL` GitHub Actions secret, deploys Trigger.dev, then deploys the web app. A migration or worker-deployment failure blocks web deployment. Never use `db:push` or rewrite applied migrations. Rerunning a successful migration is a no-op.

Vercel exports sensitive environment values as empty strings, so its downloaded environment file is not a migration credential source. Keep the Actions migration secret aligned with the production database when credentials rotate; missing configuration fails before migration.

This migration creates empty storage; it does not backfill data or enable daily definitions. Deployment is not live-provider certification. Keep new daily definitions disabled until their scope is explicitly approved.

## Administrator controls

Use the existing authenticated tRPC client with an organization owner/admin session:

| Procedure under `klaviyoSnapshots` | Purpose |
|---|---|
| `configure` | Set a dataset's definition and explicit `dailyEnabled` flag |
| `refresh` | Prepare and dispatch a manual refresh; return its durable snapshot ID |
| `retryDispatch` | Repair a pending handoff using that same snapshot ID |
| `status` | Inspect definitions, published scopes, and latest refresh status |
| `history` | Page through scoped run history |

These controls are not OpenAPI/API-key endpoints. Members, API keys, and worker principals cannot use them. Configuration and inspection do not queue work. Missing provider credentials do not prevent inspection of an otherwise accessible stored connection.

- Campaigns and metrics can be refreshed without a definition or metric selection.
- Events require 1–20 distinct metric IDs and a bounded window, or a configured definition.
- Campaign values require an explicit conversion metric and bounded window, or a configured definition.
- A manual `oneOff` window never enrolls recurring work.
- Daily-enabled definitions run on an independent 20:30 UTC schedule. Evidence/Lab eligibility does not gate this stage.

After a run publishes, use its exact `resolvedScope` from status/history for event/report reads. Do not guess a rolling window's resolved boundaries. GETs do not combine overlapping snapshots or aggregate report rates/distinct counts to satisfy another window. `not_available` means an explicit matching refresh is needed, not zero results.

The first read selects the latest publication; continuations remain pinned to it. Use `snapshotId` for retained history. Old successful data remains readable with stale/refresh-failure metadata. Disabled, uninstalled, rebound, or ambiguous connections are not alternative-account fallbacks.

## Privacy and limits

Published source history has no automatic age pruning in this slice; storage grows with observations. Existing 90-day evidence retention is unchanged. Erasure overrides history retention and removes affected staging/history content while retaining suppression tombstones. Identifiable events with unresolved privacy material fail closed.

Campaign-value completeness remains `unverified`; publication does not certify provider totals, pagination, DST, or hourly boundary semantics. These warnings remain visible in responses. No rates are summed and provider revenue is not relabeled Shopify revenue.

## Local verification

New snapshot DB suites require `SNAPSHOT_TEST_DATABASE=1`, an explicit loopback `DATABASE_URL` with a `snapshot_*` database name, PostgreSQL 16, and `TZ=UTC` for both server and test process. Disable env-file loading and block external networking. CI provides this isolated setup.

The repository's historical migrations cannot replay from an empty database (`0010`/`0011` both produce `ad_account`). The test harness uses the existing prerequisite fixture and relevant real migrations, then applies the new generated snapshot migration unchanged. This is not a claim that the entire historical chain replays from zero.
