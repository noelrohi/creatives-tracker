# Klaviyo read parity through OpenAPI

> Superseded: the user corrected the live-read architecture to durable Postgres snapshots. See `2026-09-07-klaviyo-postgres-snapshots-design.md`. Preserve this document as the design history of the first PR implementation, not the current target.

## Approved direction

Expose the four Klaviyo data-read capabilities implemented in ecomconn through Adsolute's existing OpenAPI infrastructure. Add the missing provider fields and reads while preserving the current Klaviyo Lab, evidence ingestion, matching, attribution, privacy lifecycle and scheduled jobs.

The user clarified that API/CLI/export-platform parity was not intended and approved OpenAPI data parity. The user subsequently approved this written design; implementation is authorized within this scope.

Comparison and verification log: `docs/klaviyo-parity-matrix.md`.

## Scope

In scope:

- Campaigns across email, SMS and mobile push, including explicit archived/unarchived traversal.
- Reviewed campaign and campaign-message fields, including schedule/send times and subject/preview text.
- Paginated account metric catalog.
- Minimized events for selected metric IDs and a bounded time window.
- Campaign performance grouped by campaign/message/channel, with all 17 ecomconn statistics.
- Four typed, authenticated OpenAPI reads with bounded JSON responses and documented pagination/time semantics.

Out of scope: a CLI, NDJSON delivery protocol, export platform, MCP tools, generic provider proxy, general multi-connection onboarding, new secret custody, connection-settings UI, new schedules, marketing writes, standalone profiles/lists/segments and any ecomconn feature that is only research/deferred work.

## Architecture

Use additive live-read modules rather than repurposing the persisted evidence pipeline. Internal evidence models intentionally accept recognized event families and stronger interpretation rules; arbitrary metric reads must not enter those tables or affect conclusions.

```text
OpenAPI request
  existing authentication + org/read authorization
  validated read input
  server-resolved org pilot connection + credential binding
  dedicated Klaviyo read service
    existing hardened transport, additively extended where required
    fixed endpoint/query/body + bounded provider response
    reviewed projection and continuation
  declared Zod output schema
  bounded JSON response
```

Responsibilities:

- `src/lib/klaviyo/read-contracts.ts`: closed input/output schemas and reviewed fields; no I/O.
- `src/lib/klaviyo/reads.ts`: request construction, normalization, pagination traversal and report-time handling; injectable client/clock for tests.
- `src/lib/klaviyo/read-service.ts`: org-scoped connection lookup, credential resolution, lifecycle/account checks and sanitized error translation.
- `src/lib/klaviyo/client.ts`: additive provider operations/transport protections. Keep existing public method behavior compatible with evidence callers.
- `src/lib/trpc/routers/klaviyo-reads.ts`: four read procedures with OpenAPI metadata, composed under `klaviyoReads` in `_app.ts`.
- Adjacent tests and OpenAPI guide documentation; no schema migration expected.

These are responsibility boundaries, not a requirement to duplicate existing helpers. Reuse helpers when their contracts fit. No ecomconn package dependency is needed.

## API contract

Routes follow `openApiQueryMeta` conventions:

| GET route | Input | Output |
|---|---|---|
| `/api/openapi/klaviyoReads/campaigns` | Optional continuation | Campaigns and included messages, next continuation |
| `/api/openapi/klaviyoReads/metrics` | Optional continuation | Metric ID/name records, next continuation |
| `/api/openapi/klaviyoReads/events` | Ordered `metricIds` (1–20 unique IDs), ISO `since`/`until`, optional continuation | Minimized event records, next continuation |
| `/api/openapi/klaviyoReads/campaignValues` | `conversionMetricId`, ISO `since`/`until`, optional continuation if supported | Campaign/message/channel report rows, requested/provider timeframe metadata, explicit completeness status |

Use the existing OpenAPI adapter's documented encoding for arrays. If it cannot express a typed array query parameter correctly, fix/test that narrow adapter behavior or use its existing supported input encoding rather than silently changing the contract.

Metric selection is per read request because persistent allowlist settings are outside the approved scope. This supplies the same data selection capability as ecomconn without adding a control plane. The conversion metric is explicit rather than implicitly taking the first configured metric. Neither input selects an organization/account/credential; authority is always server-derived.

Snapshot reads reject window parameters. Events use inclusive start/exclusive end, preserve the selected metric order, and complete a metric's cursor chain before moving to the next. Campaign traversal covers all six channel/archive combinations and resets the provider cursor on every transition. One API page performs bounded work; clients follow continuation until null. Empty provider pages must not cause valid continuation to disappear.

Continuations carry only bounded traversal state, not provider URLs or credentials. Validate their version, endpoint, org/connection and original request fingerprint on every use; retain server-side connection authorization independently. A continuation is not a credential. Reject malformed, cross-request or cross-connection reuse. No exactly-once/snapshot-isolation claim: provider changes during pagination may change records, and consumers deduplicate by returned identity.

Historical event windows are limited to the previous 365 days with a positive span of at most 365 days. Reject future or reversed windows explicitly. This is independent of the existing 90-day evidence backfill/retention policy, which remains unchanged. Campaign report windows also enforce the provider-supported maximum and return their actual requested provider window semantics.

## Reviewed fields

Use ecomconn `packages/connectors/src/klaviyo/schema.ts` as the field-level oracle:

- Campaign: ID, name, status, archived, created/updated, nullable scheduled/send timestamps.
- Message: ID, parent campaign ID, channel, created/updated, nullable subject/preview.
- Metric: ID and nullable name.
- Event: event ID, metric ID/name, datetime, profile ID/external ID, value, UUID, order ID and currency. Verify each event's metric relationship matches the requested metric. Join included resources by type/ID, never array order.
- Campaign values: campaign ID, campaign-message ID, send channel, conversion metric ID, provider timeframe start/end, and all 17 provider statistics listed in the matrix. Preserve nullable values and provider fraction rates. Use campaign/message/channel/metric/window as logical row identity.

Do not return email, phone, addresses, sender fields, message bodies, arbitrary profile/event properties, raw provider bodies, identity HMACs, or diagnostic inspector internals. Profile IDs/external IDs are pseudonymous identifiers, not anonymous data. Subject/preview and other provider strings are untrusted content, never HTML to execute. General reads do not add local storage of these records.

## Reporting semantics and completeness

Keep provider campaign performance separate from Shopify revenue and existing published report generations. New fields do not modify existing report fingerprints, consumers or scheduled requests by default.

Validate pinned Klaviyo report behavior against primary provider documentation during implementation. ecomconn converts instants to account-local wall time, subtracts one second from the exclusive end and labels the sent values with a misleading `Z`; do not treat those values as UTC. Return the IANA account timezone, requested instant window and provider wall-time window separately. Test DST, fractional-hour zones, invalid zones and end-boundary behavior. If provider hour rounding prevents an exact arbitrary window, expose that limitation rather than claiming exact filtering.

Reports are low quota. Never issue unbounded auto-pagination or silently partition a request into many reports. Honor retry guidance and bounded request budgets. ecomconn currently stops after one report response and acknowledges unresolved continuation. Inspect documented continuation and implement it if supported; otherwise explicitly return completeness as unverified, not a false complete flag. A missing documented cursor is not evidence of account-wide completeness. Keep this row blocked for live certification if fixtures/docs cannot establish it.

## Authorization and failures

Use `orgProcedure` and the existing API-key `read` scope policy. Resolve the pilot connection inside the authenticated organization; reject absent, uninstalled, unbound or mismatched connections before provider access. Validate configured account identity using the existing binding contract and ensure credentials cannot be used for another org/store. No caller-supplied key or account ID.

Existing `orgAdminProcedure` operations remain untouched, including administrative reads, probe/join approval, sync triggers and uninstall. Adding read routes must not make those procedures externally callable.

Return fixed safe errors for unavailable configuration, invalid continuation/window, provider authorization/rate-limit failures and malformed data. Never relay provider response bodies or secret-bearing exceptions. Enforce response-byte/record limits, request timeout, fixed HTTPS origin, rejected redirects and cursor-only pagination. Report rate limits must remain visible to callers; do not conceal partial/failing reads as success.

The current configured pilot is the supported deployment target. Other organizations require separately scoped onboarding work and receive a not-configured response. This is an explicit scope boundary, not a promise of general multi-account support.

## Implementation and compare → verify rounds

1. **Read contracts and provider adapters:** add fixture-backed readers; verify exact campaign chains, event envelopes, statistics, report boundaries, output minimization and safe continuation. Re-run existing client/dimensions/event/reports tests.
2. **OpenAPI integration:** add scoped service/router composition, output schemas and guide examples. Verify generated OpenAPI plus actual adapter requests, API-key scope denial, org isolation, unavailable/lifecycle states, safe provider errors and unchanged admin gates.
3. **Closure:** compare each field/behavior against ecomconn's four registered jobs and five schemas; update matrix rows with implementation/test paths. Run relevant unit/component/integration tests, typecheck, lint and build. Fix regressions and repeat comparison until no actionable in-scope code gaps remain.

Baseline already run: five Klaviyo test files, 141 tests passed. This is not full parity verification.

Run fixture/unit checks without provider calls. DB integration checks may need a configured isolated test database; report blocked checks rather than connecting to production. Live provider calls, secrets changes, migrations and deployment are not part of this design approval. Missing live access blocks live certification, not local implementation.

## Acceptance and remaining gate

Every in-scope matrix row must identify implementation evidence and executed verification, with live-only limitations marked separately. Deferred/out-of-scope rows remain visible but are not parity failures for the user-approved OpenAPI target. Preserve all Adsolute-only regression boundaries listed in the matrix.

Written-spec review is complete. The referenced `writing-plans` skill is not available in the installed skill list; implementation follows `docs/superpowers/plans/2026-09-07-klaviyo-openapi-parity.md` instead.
