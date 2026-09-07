# Klaviyo parity: ecomconn → Adsolute

## Round 0 — source comparison and regression baseline

Compared 2026-09-07. Adsolute HEAD `7a750e4`; ecomconn HEAD `c0536219bd25f1dde4187524f9cb138485658760`. Both working trees were clean before this audit. No provider calls, migrations, credentials changes, or implementation performed.

**Approved target (scope clarified after Round 0):** all four shipped Klaviyo data-read capabilities in ecomconn, exposed through Adsolute's existing org-authorized OpenAPI. Preserve Adsolute's existing functionality. No new CLI, streaming export platform, general connection onboarding, custody system, MCP tools, or ecomconn control plane. The user approved this direction; the focused written design awaits review.

Status: **Present** = implemented equivalent; **Partial** = some behavior exists but parity is not established; **Missing** = no equivalent found; **Extra** = Adsolute functionality to preserve. These are source findings, not live-provider certification.

### Source key

Paths prefixed E are under `~/sandbox/ecomconn`; A under `~/sandbox/adsolute`.

- E1: `packages/connectors/src/klaviyo/index.ts` — registration, config, scopes.
- E2: `packages/connectors/src/klaviyo/jobs.ts` — four readers and normalization.
- E3: `packages/connectors/src/klaviyo/schema.ts` — five output schemas.
- E4: `packages/api/src/routers/index.ts` — setup, settings, delivery, diagnostics and access checks.
- E5: `packages/core/src/delivery/{config,engine,protocol,provider-client,inspection}.ts` — bounded delivery contract.
- E6: `apps/cli/src/{help,orpc,journal}.ts` — CLI and content-free history.
- E7: `apps/web/src/components/blocks/connections.tsx` — setup/settings/disconnect UI.
- E8: `tests/klaviyo.test.ts`, `tests/control-plane-e2e.test.ts` — fixture oracles.
- A1: `src/lib/klaviyo/client.ts` — provider client.
- A2: `src/lib/klaviyo/{dimensions,dimension-repository}.ts` — campaign/flow metadata.
- A3: `src/lib/klaviyo/{discovery,types,event-normalizer,source-runner,source-store}.ts` — source ingestion.
- A4: `src/lib/klaviyo/{reports,report-repository}.ts` — provider reports.
- A5: `src/lib/klaviyo/{credential-provider,connection-lifecycle}.ts`, `scripts/klaviyo-bootstrap-wizard-core.ts` — pilot credentials/lifecycle.
- A6: `src/lib/trpc/routers/klaviyo.ts`, `src/lib/trpc/init.ts` — 28 session-admin procedures.
- A7: `src/components/blocks/attribution/klaviyo/`, `src/app/(protected)/attribution/klaviyo/page.tsx` — Lab UI.
- A8: `src/app/api/mcp/route.ts`, `src/lib/trpc/openapi.ts`, `src/lib/api-keys.ts` — external access infrastructure.
- A9: `trigger/klaviyo-*.ts`, `src/lib/klaviyo/incremental-sync.ts` — durable workflows.

## Provider feature matrix

| Capability | ecomconn | Adsolute now | Status / required delta | Evidence |
|---|---|---|---|---|
| Account identity and timezone lookup | Private-key account read at setup | Discovery and pilot binding | Present provider read; onboarding differs below | E4; A1,A3,A5 |
| Pinned API and safe continuation | Revision 2026-07-15; fixed paths, cursor-only paging | Same revision; stricter next-link origin/path validation | Present; preserve stronger checks | E2,E5; A1 |
| Email and SMS campaigns | Both channels | Both channels | Present | E2; A1,A2 |
| Mobile-push campaigns | Third channel | Client union only email/SMS | Missing | E2; A1 |
| Archived campaign completeness | Explicit false/true sweep for each of three channels | No explicit archive sweep | Partial; six-chain traversal needed | E2; A1,A2 |
| Campaign envelope | ID/name/status/archived/create/update/scheduled/send timestamps | Metadata ingestion is narrower | Partial; preserve all eight schema fields | E2,E3; A1,A2 |
| Message envelope | Parent ID/channel/create/update/subject/preview | Message traversal and labels; no equivalent subject/preview output contract | Partial; reviewed content fields and safe output needed | E2,E3; A1,A2 |
| Complete metric catalog | Paginated ID/name snapshot | Paginated discovery, including integration metadata | Present internally; missing general consumer snapshot | E2,E3; A1,A3,A6 |
| Organization-selected metrics | Ordered 1–20 distinct metric IDs | Closed recognized event families | Missing configurable arbitrary-metric reader | E1,E4; A3 |
| Selected-metric event traversal | Each metric's entire cursor chain, half-open time range, relationship validation | Per-metric bounded ingestion for supported event families | Partial; separate general reader and mismatch checks needed | E2; A1,A3 |
| Minimized event envelope | ID, metric ID/name, datetime, profile ID/external ID, value, UUID, order ID, currency | Evidence-oriented normalization; no equivalent general envelope/export | Partial; notably profile external_id is not requested | E2,E3; A1,A3 |
| Campaign values reports | Campaign/message/channel rows for first configured metric | Campaign/flow reports with conversion metric and generation publication | Partial; explicit campaign-message grouping and consumer contract | E2,E3; A1,A4 |
| Core campaign statistics | Recipients, unique opens/clicks, conversions/value | All five | Present | E2; A4 |
| Additional campaign statistics | 12 delivery/rate/bounce/unsubscribe/spam measures | Not in request allowlist | Missing; exact list below | E2,E3; A4 |
| Account-local report interval semantics | Local wall time; exclusive end minus one second; sent window retained | Existing ISO request path; account/store timezone discrepancy in scheduled path | Partial; provider semantics require explicit contract and regression tests | E2; A1,A4,A6,A9 |
| Report identity/versioning | Campaign/message/channel/metric/window composite key; digest version | Scoped fingerprints and published generations | Partial; verify equivalent per-message/window export identity without replacing publication machinery | E3,E5; A4 |
| 365-day configurable reads | Default lookback/span 365; caller windows/checkpoints | Initial evidence policy 90 store days, durable incremental windows | Missing general bounded historical read independent of evidence retention | E1,E5; A3,A9 |

Additional statistics: `delivered`, `delivery_rate`, `open_rate`, `click_rate`, `conversion_rate`, `revenue_per_recipient`, `bounced`, `bounce_rate`, `unsubscribes`, `unsubscribe_rate`, `spam_complaints`, `spam_complaint_rate`. Preserve provider fractions and nullable values; do not sum rates or relabel provider revenue as Shopify money.

The five source record contracts are `klaviyo_campaign`, `klaviyo_campaign_message`, `klaviyo_campaign_value`, `klaviyo_metric`, and `klaviyo_event`, all v1. E3 is the field-level acceptance oracle; an internal fetch alone does not satisfy consumer-access parity.

## Tools, setup, and operational comparison (scope narrowed)

This section retains the original comparison for context, not implementation commitments. **Only OpenAPI data reads, their authentication, bounded pagination, transport safety, and minimized response contracts are in scope.** CLI, NDJSON exports/checkpoints, general onboarding/settings UI, new credential custody, catalog tooling, delivery history/admission platform and member-bound editing are explicitly out of scope. Reuse the current configured pilot connection; do not broaden administrative access.

| Capability | ecomconn | Adsolute now | Status / required delta | Evidence |
|---|---|---|---|---|
| General Klaviyo connections | Named org connections; provider account binding, vault reference | One environment-bound Reviv pilot/store | Missing multi-connection onboarding; preserve pilot | E4; A5 |
| Credential custody and disconnect | Vault write/delete; no Klaviyo-side key revocation | Server credential provider; privacy-aware uninstall | Partial; secure general custody/lifecycle needed, not plaintext DB keys | E4; A5 |
| Metric settings and conversion selection | Editable ordered allowlist; first metric drives campaign values | Evidence metric discovery/probe configuration | Missing general settings contract | E1,E4,E7; A3,A6 |
| Lookback/span settings | Editable positive integers, span ≤ lookback | Evidence policy and Lab date filters | Missing independent read bounds | E4,E5,E7; A3,A7 |
| Setup/settings/status/disconnect UI | Connections directory, forms, status and latest delivery | Pilot bootstrap wizard and Lab diagnostics | Partial; general connection UI needed | E7; A5,A7 |
| Machine-readable catalog and schemas | Connector/job/record inspection via API/CLI | No Klaviyo consumer catalog | Missing | E4,E5,E6; A8 |
| Public read API | Four jobs through org-authorized RPC/REST delivery | Klaviyo tRPC is session-owner/admin only; no OpenAPI metadata | Missing external read surface; do not loosen existing admin procedures | E4; A6,A8 |
| CLI | inspect/docs/connections/fetch/deliveries/doctor/organizations | Operator bootstrap script only | Missing consumer CLI equivalents | E6; A5 |
| MCP | No implemented MCP server | MCP has three unrelated tools, no Klaviyo tools | Not an ecomconn requirement; possible additive access adapter | E4,E6; A8 |
| Bounded NDJSON export | Start/record/checkpoint/commit or abort; partial streams uncommitted | Durable DB publication, not consumer streaming | Missing equivalent export/commit semantics | E5,E6; A3,A4 |
| Checkpoint/window behavior | Watermark after successful bounded read; snapshot rejects windows | Durable internal cursors/checkpoints | Partial; public namespaced checkpoint contract required | E5; A3 |
| Resource limits/cancellation | Delivery-wide pages/records/bytes/deadline; cancel propagates | Request timeout/retries and durable task budgets | Partial; request-bound export budgets and abort tests needed | E2,E5; A1,A9 |
| Admission and diagnostics | Org/connection concurrency/start budgets; content-free outcomes, doctor | Task queues, sync runs and pilot health | Partial; external-read admission and delivery history needed | E4,E5,E6; A6,A9 |
| Consumer auth vs admin writes | Org reads for sessions/agents/OAuth; scope edits session-admin only | Org-scoped keys/MCP infrastructure; all Klaviyo operations session-admin | Partial; deliberately scoped read permissions required | E4; A6,A8 |
| Data minimization | No email/phone/address/body/arbitrary properties emitted | Strong evidence redaction, identity HMAC and privacy closure | Preserve; general exports need separate reviewed projection, not inspector bypass | E2,E3; A3,A5 |

No ecomconn background sync, outbound webhook delivery, marketing writes, or provider-data warehouse was found. Its jobs execute on demand and return streams; delivery history contains metadata only. Exact command names or its generic multi-provider framework need not be copied if Adsolute supplies documented functional equivalents, subject to design approval.

## Adsolute-only functionality — mandatory regression boundary

| Capability to preserve | Evidence |
|---|---|
| Flow/action/message traversal and flow values reports | A1,A2,A4 |
| Tracking settings evidence | A1,A2 |
| Shopify-native metric discovery, probe approval and reviewed join rules | A3,A6 |
| Deterministic/advisory order matching, ambiguity and product comparisons | `src/lib/klaviyo/{matcher,match-service,product-match}.ts` |
| Attribution claims, referenced-event hydration and exact-profile journeys | `src/lib/klaviyo/{claims,claim-repository,journey}.ts` |
| Email revenue/evidence gaps and aggregate list health | `src/lib/klaviyo/{email-attribution,list-health}.ts` |
| Durable staging/publication/currentness, source replay and scheduling | A3,A4,A9 |
| Identity rotation, erasure suppression/privacy closure and safe uninstall | `src/lib/klaviyo/{identity-rotation,privacy-match-closure,connection-lifecycle}.ts` |
| Canonical Shopify money and production attribution isolation | `src/lib/klaviyo/{advisory-isolation,claims-reporting-isolation}.integration.test.ts` |
| Existing Lab access gates and all admin-only mutations | A6,A7 |

## Approved direction and proposed implementation rounds

Focused design: `docs/superpowers/specs/2026-09-07-klaviyo-openapi-parity-design.md`.

1. **Provider read contracts:** dedicated, minimized campaign/message, metric, event and 17-statistic campaign-report readers. Reuse safe transport without changing evidence ingestion or published report semantics. Fixture tests against E3/E8 and existing regression tests.
2. **OpenAPI integration:** four explicitly typed query procedures using existing org/read authorization and server-resolved pilot credentials. Bounded JSON pages, continuation bound to the original request, documented provider-time/report-completeness limitations. No database schema changes or onboarding UI.
3. **Closure:** repeat field-by-field comparison and update each in-scope row with test evidence; run unit tests, HTTP/OpenAPI contract tests, relevant regression/component tests, typecheck, lint and build. Live verification is separate and must remain unverified if unavailable.

The alternative of extending persisted evidence for every arbitrary metric risks changing attribution and retention semantics. A separate ecomconn runtime is unnecessary for the clarified OpenAPI-only target.

## Verification log

Round 0 command:

```sh
bun run test src/lib/klaviyo/client.test.ts src/lib/klaviyo/dimensions.test.ts src/lib/klaviyo/event-normalizer.test.ts src/lib/klaviyo/reports.test.ts src/lib/trpc/routers/klaviyo.test.ts
```

Result: **5 files, 141 tests passed**. A Node `module.register()` deprecation warning was emitted. This is a narrow regression baseline, not full-suite or live parity verification. ecomconn tests were inspected, not run. No implementation round has started.

For each later round record: changed rows; source/test paths; commands and results; new gaps; unresolved blockers. Mark a row verified only for the layers actually exercised (unit, integration, UI, live).

## Approval and blockers

- **Written design review required before implementation by repository skill.** The user approved OpenAPI data parity, explicitly excluding a CLI/export platform. Review the linked focused spec next.
- **Credential custody is no longer a design blocker:** reuse the existing server-side pilot credential provider and org-scoped connection lookup. Organizations without that configured connection receive an explicit unavailable/not-configured error. General multi-account setup is out of scope.
- **Permissions:** new read procedures use existing org/read authorization; current session-admin evidence reads, sync/review mutations and uninstall remain unchanged. No new scope-editing capabilities.
- **Live report completeness:** ecomconn unconditionally stops after one response; its docs explicitly leave report pagination unresolved. Port the implemented contract but do not copy silent completeness assumptions. Live-account evidence may be needed; unresolved completeness must remain visible.
- **Report interval semantics:** source serializes account-local wall time with a `Z` suffix, subtracts a second from the exclusive end, and acknowledges provider hour rounding. Validate pinned provider behavior rather than interpreting these strings as UTC or blindly replacing existing reporting semantics. DST and non-hour-aligned intervals require tests.
- **Deployment/live verification:** provider scopes, vault configuration, DB migrations and Trigger deployment may require operator input. Missing credentials should block live certification, not fixture-backed implementation. No production actions or live calls have been authorized/performed here.
