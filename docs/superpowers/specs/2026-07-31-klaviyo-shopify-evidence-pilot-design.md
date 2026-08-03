# Klaviyo + Shopify Evidence Pilot Design

**Status:** Approved for specification

**Approved:** 2026-07-31

**Pilot tenant:** Reviv

**Chosen approach:** Discovery-first evidence graph
**Product posture:** Pilot implementation with a product-shaped core

## 1. Decision summary

| Decision | Approved direction |
| --- | --- |
| Product scope | Connect Shopify orders and products to Klaviyo evidence, plus campaign and flow claims |
| Primary lens | Shopify order first |
| Effect on attribution | Advisory only; never change the production Shopify attribution bucket |
| Identity | Limited identity: provider customer/profile IDs plus HMAC-only normalized email |
| Journey data | Allowlisted events only |
| Historical window | Initial 90-day backfill, followed by incremental refreshes |
| Pilot credential | Environment-provided Klaviyo private API key |
| Inspector | Normalized fields beside redacted, allowlisted source evidence and key/type fingerprints |
| Product money | No product-level revenue allocation; Shopify Net sales remains order-level |
| Initial merchant | Reviv only |

The pilot must answer a narrow question with defensible evidence: **can Klaviyo help explain and trace a Shopify order and its products without becoming a second commerce ledger or silently inventing attribution?**

## 2. Context and repository ground truth

Adsolute already ingests Shopify orders, refunds, customer-journey data, and one order-level Net sales value. It does not currently persist Shopify line items, product IDs, variant IDs, SKUs, quantities, customer IDs, or privacy-safe customer identity. The existing attribution rules already classify `utm_source=klaviyo` into a Klaviyo bucket, and the attribution UI already labels that bucket as Klaviyo email. There is no Klaviyo API client, connection, source schema, event ingestion, or evidence matcher.

The existing Shopify attribution contract remains load-bearing:

- Shopify is the commerce and revenue truth.
- Each Shopify order has one production attribution bucket.
- Bucket totals reconcile exactly to Shopify order Net sales.
- Source claims belong in source-specific records and adapters.

Klaviyo's native Shopify `Placed Order` and `Ordered Product` events originate from Shopify. They are useful copies with additional message attribution and interaction context, but they are not independent proof of an order or a replacement revenue ledger. Klaviyo revenue semantics also differ from the app's Shopify Net sales calculation and do not reliably reflect later refunds, cancellations, or edits.

The external FrameSignal repository does not contain a Klaviyo implementation. Its useful architectural guidance is conceptual: separate source truth, provider claims, and connection evidence; keep assignments versioned and explainable; preserve stale data during failures; and never promote fuzzy identity into confirmed attribution.

## 3. Goals

1. Add enough Shopify product detail to trace an order through its purchased products without allocating order revenue to lines.
2. Ingest a bounded, privacy-minimized Klaviyo dataset for the approved 90-day window.
3. Resolve Klaviyo campaign, flow, message, variation, and attributed-interaction relationships.
4. Match Klaviyo order evidence to Shopify orders through explicit, inspectable rules.
5. Compare Shopify order lines with Klaviyo product observations and explain mismatches.
6. Provide an order-first playground for coverage, validation, timelines, claims, and redacted source inspection.
7. Quantify what identifiers actually exist in Reviv data before treating undocumented fields as stable joins.
8. Build provider, persistence, matching, and credential boundaries that can later support OAuth and additional merchants.

## 4. Non-goals

- Changing, augmenting, or automatically correcting the production Shopify attribution bucket.
- Allocating Shopify Net sales, discounts, refunds, or cancellations across products.
- Treating Klaviyo conversion value as Shopify revenue.
- Importing full Klaviyo profiles, addresses, phone numbers, names, or unrestricted custom properties.
- Persisting complete raw API responses or unrestricted URLs.
- Reading the Klaviyo catalog; the public catalog API does not reliably expose the native Shopify catalog.
- Confirming an order match from timestamps, amounts, identity, or product similarity alone.
- Multi-merchant OAuth, self-service connection management, or credential storage in the database.
- Replacing the existing attribution ledger or exposing pilot evidence to production attribution consumers.
- Declaring campaign/flow report aggregates to be order-level attribution.

### 4.1 Rejected approaches

- **Generic raw-JSON playground** — fast to start, but it creates privacy risk, pushes provider-shape handling into the UI, and leaves no trustworthy join model.
- **Claims-first dashboard** — visually useful but can make Klaviyo campaign/flow numbers look authoritative before order linkage and product coverage are understood.

The selected evidence-graph approach costs more normalization work but directly tests the unknowns and preserves a clean boundary between truth, claims, and matching evidence.

## 5. Truth model and invariants

The design keeps three concepts physically and semantically separate:

1. **Shopify truth** — orders, order lines, refunds, cancellation state, and order-level Net sales.
2. **Klaviyo source records and claims** — events, product observations, marketing objects, interaction attribution, and aggregate reports.
3. **Advisory connection evidence** — versioned results explaining whether and how a Klaviyo record corresponds to a Shopify order.

```text
Shopify API                                  Klaviyo API
    |                                             |
    v                                             v
orders + order lines                    allowlisted source records
    |                                             |
    +-----------------> advisory matcher <--------+
                              |
                              v
                 versioned match explanations
                              |
                              v
                  order-first pilot playground

Production attribution bucket ------------------ unchanged
Shopify Net sales reconciliation ---------------- unchanged
```

The following invariants are mandatory:

- Every Klaviyo record is scoped by organization, Shopify store, and Klaviyo connection.
- External provider IDs are never assumed globally unique.
- One Klaviyo account maps to one Shopify store during the pilot.
- A confirmed match requires an explicit, validated deterministic identifier.
- Diagnostic evidence can rank or explain candidates but cannot confirm them.
- Product-match status is independent of order-match status, but comparison runs only after a defensible order association exists.
- Klaviyo claims never overwrite Shopify source, revenue, or bucket columns.
- Shopify evidence-enrichment writes are allowlisted to customer ID, versioned identity digests, order lines, and evidence-run metadata. They cannot update `netSales`, refunds, customer journey, bucket/rule version, Meta verification, cancellation, or source fields.
- Every match publication emits one explicit result for each inspected Shopify order and in-scope Klaviyo `Placed Order` event; a later incident-edge closure may leave a source entity API-only `not_evaluated`. Order-side `no_klaviyo_event` is distinct from event-side `unmatched`, and duplicate conversion events are visible.
- Replacing either endpoint also closes every current selected/dependent incident edge. An outside-window counterpart is API-only `not_evaluated`; an inside-window no-event/unmatched conclusion is explicitly window-relative and never claims global absence.
- All derived conclusions carry a matcher version and evidence explanation.

## 6. Architecture

```text
Klaviyo private key (server/worker environment only)
    -> KlaviyoCredentialProvider
    -> Klaviyo API client
    -> discovery + allowlist registry
    -> normalizer/redactor
    -> source and claim tables
    -> advisory matching service
    -> tRPC pilot queries
    -> /attribution/klaviyo

Existing Shopify monetary sync (unchanged)
    -> shopify_order + shopify_refund
    -> identify orders for evidence enrichment

Separate Shopify evidence-enrichment task
    -> explicit Reviv store credential/domain validation
    -> order lines + optional limited identity query
    -> Shopify evidence normalizer (plaintext email discarded after HMAC)
    -> shopify_order identity + shopify_order_line + source_identity_hmac
    -> advisory matching service
```

### 6.1 Components

- **`KlaviyoCredentialProvider`** resolves a credential for a specific connection. The pilot implementation reads one named environment secret; callers never read environment variables directly. A later OAuth provider can implement the same boundary.
- **Klaviyo API client** owns authentication headers, API revision, pagination, rate-limit handling, bounded retry behavior, and sanitized errors.
- **Discovery registry** identifies the account, native Shopify metrics, allowed journey metrics, tracking settings, and property aliases observed during the live probe.
- **Normalizer/redactor** maps approved fields into typed records before database or application logging. Unknown values are dropped.
- **Shopify evidence enricher** runs separately from the existing monetary order/refund ingest. Protected-data or line-item failures can make evidence stale or unavailable but cannot block or roll back revenue synchronization.
- **Sync tasks** run durable, checkpointed discovery, dimensions, events, reports, and matching stages.
- **Matching service** produces deterministic, versioned advisory results and product comparisons.
- **Pilot tRPC router** exposes paginated, organization-authorized reads and explicit sync/recompute mutations.
- **Playground route** presents Shopify truth first and labels all Klaviyo material as evidence or claims.

API revisions are pinned as named constants per endpoint family rather than inferred from “latest” or hidden behind one global revision. Every source row and run records the revision that produced it so one endpoint family can be upgraded and verified independently.

### 6.2 Connection boundary

The pilot may have one environment credential, but every Klaviyo entry job receives an explicit `connectionId` or a globally unique internal run/workflow ID that resolves the connection and full scope server-side. Bounded children carry only the minimum internal resource ID required by their durable database graph; they never accept authoritative organization/store scope from a browser. The mode-only Shopify evidence start is the deliberate single-configured-store exception: it resolves the allowlisted store server-side and every continuation carries only its generated `evidenceRunId`. Klaviyo Accounts identifies the Klaviyo account but does not reveal which Shopify domain is integrated. The Reviv binding therefore consists of an explicitly approved connection row containing the Reviv Shopify store and discovered Klaviyo account ID, plus successful sample-order overlap from the probe. An active Klaviyo account ID cannot be bound to more than one Shopify store. The connector never claims that Klaviyo itself verified the shop domain.

This intentionally does not copy the current global-Shopify-credential pattern, where a scheduled loop can enumerate database stores while resolving one environment shop/token. Klaviyo IDs, cursors, runs, and matches must never be joined or written using a global credential assumption.

The Reviv evidence bootstrap resolves the existing store from the allowlisted environment domain, loads its organization/domain, and compares the normalized values before any evidence run or remote order fetch. It never accepts a browser-supplied store ID, calls the current store-domain upsert path, creates or reassigns a store, or continues on disagreement.

Before pilot matching is enabled, the existing Shopify store upsert must also stop reassigning `organization_id` when a globally unique shop domain already belongs to another organization; that conflict must fail closed. This is a tenant-safety prerequisite, not a Klaviyo matching rule.

## 7. Klaviyo source scope

### 7.1 Minimum API scopes

- `accounts:read`
- `metrics:read`
- `events:read`
- `campaigns:read`
- `flows:read`
- `tracking-settings:read`

The pilot does not request `profiles:read` or `catalogs:read`. Every allowlisted event-ingestion mode may use the Events API's sparse related-profile include (`include=profile&fields[profile]=email`) so the response contains only the profile resource ID and email needed for in-memory HMAC generation. The profile body is not persisted. Order matching consumes HMAC evidence only from the exact order-core run; journey construction remains exact-profile-ID-only and never expands a timeline through HMAC similarity. If the sparse email is unavailable for the active API revision or credential, the digest remains null; the connector does not silently broaden access to the Profiles API. Rotation and erasure cover every retained digest-bearing allowlisted event, including journey-only events.

### 7.2 Allowed event families

- Shopify `Placed Order`
- Shopify `Ordered Product`
- `Clicked Email`
- `Clicked SMS`
- `Active on Site`
- `Viewed Product`
- `Added to Cart`
- `Checkout Started`

Metric selection uses Klaviyo metric IDs and integration metadata, not names alone. `Placed Order` and `Ordered Product` must resolve uniquely to Shopify-native metrics. A same-named custom/API metric is not an acceptable substitute.

### 7.3 Allowed normalized properties

The alias registry may map observed provider keys into these canonical classes:

- Explicit order identifier and provider unique event identifier.
- Product ID, variant ID, SKU, product/variant name, and quantity.
- Provider-reported conversion value and currency, retained only as a source observation.
- UTM source, medium, campaign, ID, and term where present; content is optional/custom rather than assumed canonical.
- Safe page path, safe link host/path, first-page path, and coarse onsite association flags.
- Bot-click indicator and attributed-interaction type.
- Campaign, flow, message, variation, channel, and status relationships.

Unknown property **values** are never stored. The inspector fingerprint retains literal names only for approved keys. Every non-allowlisted key is represented by a bounded hash plus coarse JSON type (`string`, `number`, `boolean`, `array`, `object`, or `null`) so schema drift is visible without persisting its value or name.

Full URLs, query parameters, `$extra`, addresses, phone numbers, names, unrestricted profile properties, and arbitrary custom properties are excluded.

UTM values and safe paths still pass through bounded scalar sanitization. Only `https` hosts from an explicit merchant/domain allowlist are retained. Userinfo, query, and fragment are always removed. Email-like values, phone-like values, known profile/external-ID expansions, and long opaque path segments are replaced with a redaction marker. Every non-allowlisted property key is hashed, even when its characters look safe. A field being allowlisted does not make every possible value safe.

## 8. Data model

Names below describe the intended Drizzle/PostgreSQL model. New primary keys are opaque UUID values generated with `crypto.randomUUID()` but stored in PostgreSQL `text` columns, following this repository's existing identifier convention; they are never caller authority. Tables use the repository's existing timestamp conventions.

### 8.1 Shopify extensions

#### `shopify_order` additions

- `shopify_customer_id` — nullable Shopify customer identifier.

Before these additions become available, migration 0053 performs fail-closed legacy-scope preflights at its absolute start. It rejects any orphaned Shopify store, order whose organization differs from its store, refund whose organization/store differs from its order, monetary sync run whose organization differs from its store, or nonnull-store finding whose organization differs from its store. No preflight repairs, reassigns, or deletes data, and no 0053 catalog mutation occurs before all checks pass.

After a clean preflight, existing parent paths become tenant-scoped: orders reference stores by `(organization_id, store_id)`; refunds reference orders by `(organization_id, store_id, order_id)`; monetary sync runs reference stores by `(organization_id, store_id)`; and nullable-store findings reference stores by `(organization_id, store_id)` with PostgreSQL `MATCH SIMPLE`, preserving organization-only findings. Every replacement cascades from its scoped parent, so store deletion still reaches refunds transitively through orders.

The Shopify response email is normalized and HMACed in memory, then discarded before persistence or logging.

Shopify customer ID and email are protected customer data. Connection validation must confirm the installed credential can read the approved order/customer fields before enabling identity comparison. Identity fields remain nullable and diagnostic; unavailable protected fields do not block order/product matching. Refetching order lines for orders older than Shopify's default 60-day order window also requires `read_all_orders`. If that access is absent, the UI reports incomplete Shopify product coverage rather than implying a complete 90-day comparison.

#### `shopify_order_line`

- `organization_id`, `store_id`, and `order_id`.
- Shopify line-item ID.
- Nullable Shopify product ID, variant ID, and SKU.
- Product title and nullable variant title.
- Integer quantity and stable source position when available.
- Parent-order snapshot timestamp plus created/updated timestamps; no line-specific update timestamp is invented.

The store plus Shopify line-item ID is unique. Quantity is positive. Indexes support order, product, variant, and SKU lookup inside the store. Product, variant, title, and SKU fields are immutable purchase-time snapshots even if the catalog object is later edited or deleted. Reingesting an order replaces its line set transactionally so removed or edited lines cannot remain stale. Every line-item page must be fetched and assembled successfully before replacement begins; a truncated child connection leaves the previous complete line set intact. The table intentionally has no derived revenue, refund, discount, or attribution columns.

The existing Shopify bulk JSONL assembler currently reconstructs refund children only. The enrichment path may reuse proven parsing primitives, but it uses its own order/line operation and completion gate rather than changing the load-bearing monetary query. It must reconstruct all line-item children under their parent order before persistence and keep refund assembly and Net sales computation unchanged.

### 8.2 Connection and discovery

#### `klaviyo_connection`

- `organization_id` and `shopify_store_id`, unique together for the pilot.
- Klaviyo account ID, account name, timezone, and currency.
- Status (`pending`, `ready`, `degraded`, or `disabled`).
- Authentication mode (`environment`) and a credential-reference enum whose pilot value is the single allowlisted Klaviyo environment key; arbitrary environment-variable names are forbidden.
- Durable identity-write mode (`current_only` or `dual`) plus current/previous matching-key version labels and non-secret key checks; the previous pair is present only in `dual`.
- Last successful discovery/event/report sync timestamps.

No private key or reusable secret is stored. Ordinary writers validate environment-derived version/check pairs against both the store crypto policy and this locked gate, so environment-variable presence or same-label secret drift cannot enable writes. Post-migration bootstrap is explicit and locked: retained rows require a pre-existing policy with one version whose check matches the supplied secret; zero-row bootstrap may bind policy and gate together. A mismatch, absent policy with retained rows, or unresolved dual set blocks Plan 3 rather than blessing a new key. Ordinary writers and rotation cannot initialize a null gate. A composite foreign key guarantees that `organization_id` and `shopify_store_id` refer to the same store row. The Klaviyo account ID is unique across active connections so one account cannot be silently rebound to another Shopify store.

#### `klaviyo_probe_report`

- Connection, probe run, sampled Shopify range, and sample counts.
- Redacted key/type shapes and candidate-field coverage.
- Collision, unmatched, product-coverage, and attribution-coverage summaries.
- Status (`pending`, `passed`, or `failed`), reviewer, review timestamp, and immutable report checksum.

The report is the durable artifact for the 20–50-order probe; a successful console log is not sufficient.

#### `klaviyo_join_rule`

- Connection, event kind, source property/relationship, and canonicalization rule.
- Rule state (`candidate`, `approved`, `rejected`, or `disabled`).
- Probe-report reference, observed coverage/collision counts, approver, and approval timestamp.
- Matcher version from which the rule is active.

Undocumented provider unique-ID mappings stay disabled until an approved rule exists. Rule changes are auditable configuration changes, not inferred runtime behavior.

Canonicalization is selected from a version-controlled allowlist; an approver cannot submit arbitrary code or expressions. The pilot approval mutation requires owner/admin authorization, a passed probe, zero observed collisions, and a review note.

#### `klaviyo_metric`

- Connection-scoped Klaviyo metric ID and name.
- Integration name and category.
- Canonical metric kind from the approved allowlist.
- Ingestion-enabled and discovery timestamps.

The connection plus external metric ID is unique.

#### `klaviyo_marketing_object`

A connection-scoped hierarchy for:

- Campaign
- Flow
- Campaign message
- Flow message
- Flow-message variation

Each row stores object type, external ID, optional parent row, name, channel, status, relevant provider timestamps, and allowlisted tracking configuration. The unique key is connection, object type, and external ID.

#### `klaviyo_tracking_setting`

- Connection and optional marketing-object reference.
- Scope (`account`, `campaign_message`, or `flow_message`).
- UTM parameter name, value mode (`static` or `dynamic`), redacted value/template, and enabled state.
- API revision and fetch timestamp.

These records explain how Klaviyo intended to tag links. They remain configuration evidence and do not prove which URL a shopper visited.

### 8.3 Events and claims

#### `klaviyo_event`

- Connection and metric references.
- Klaviyo event resource ID, UUID, occurred timestamp, and fetch timestamp.
- Klaviyo profile relationship ID.
- Explicit order-ID candidate and provider unique-event-ID candidate, kept as separate fields.
- Provider-reported value and currency, visibly labelled as a Klaviyo observation.
- Redacted allowlisted property JSON.
- Key/type fingerprint, source checksum, and API revision.

The connection plus event resource ID is unique. The table never stores a complete source payload.

#### `source_identity_hmac`

- Organization and Shopify-store scope plus nullable Klaviyo connection.
- Source kind (`shopify_order` or `klaviyo_event`) and exactly one corresponding source-record reference.
- Key version and HMAC-SHA256 digest.
- Created timestamp and legacy insertion-time rotation marker (non-authoritative after the gate exists).

The source record plus key version is unique. The row is immutable: same-digest replay reuses its opaque row ID, while a changed digest replaces it so exact-run identity-observation links cascade instead of changing meaning. Current/previous role is derived from the store crypto policy and connection write gate, not the legacy row marker, so a gate transition never replaces a same source/version/digest row. Multiple versions may coexist only during a controlled rotation, which makes dual-key comparison explicit without retaining plaintext or adding global cross-tenant identifiers to source tables.

#### `identity_matching_key_binding`

- Organization and Shopify-store scope.
- Matching-key version label and non-subject fixed-context key check.
- First-bound timestamp only.

This append-only lifetime registry survives connection uninstall, digest pruning, and rotation completion; it cascades only with store/organization deletion. First use binds a label/check, exact replay is allowed, and a historical same-label/different-check attempt fails before remote calls or writes. Active policy/gate pairs, rotation graphs, and uninstall retirement receipts reference it, so a version label in old explanations always denotes one cryptographic key inside that store.

#### `identity_crypto_policy`

- One row per organization/Shopify store.
- Matching current/optional previous version labels and non-secret fixed-context key checks.
- Stable suppression version label and non-secret fixed-context key check.

The checks are tenant/store-derived HMACs of constant domain strings, never subjects or matcher inputs. Writers compare them in constant time against the lifetime registry and active policy/gate under the fixed locks, so changing a secret while reusing even a retired label fails before remote identity calls or writes. Matching rotation updates only registry-backed matching pairs atomically with the connection gate; connector uninstall preserves the lifetime registry and stable suppression binding.

#### `identity_erasure_suppression`

- Organization and Shopify-store scope.
- Suppression kind (`email`, `shopify_customer_id`, or `klaviyo_profile_id`).
- Stable compliance-key version and domain-separated HMAC-SHA256 digest.
- Created timestamp only.

This is a durable do-not-reingest control, not evidence. It stores no plaintext or raw provider alias, is excluded from matching/reports/inspector/fingerprints, survives connector uninstall and the 90-day source window, and cascades only with store/organization deletion unless an explicit compliance release removes it. Shopify and Klaviyo writers compare transient HMAC candidates under their fixed locks; a hit retains non-personal Shopify commerce but omits/clears identity, and skips/deletes the subject's Klaviyo event evidence.

#### `klaviyo_event_product`

- Event reference and source ordinal.
- Nullable product ID, variant ID, and SKU.
- Product/variant name and normalized quantity.

This represents product evidence, not a revenue line. When both `Placed Order` item arrays and `Ordered Product` events describe the same purchase, the matcher selects one evidence source for quantity comparison and never adds both together.

#### `klaviyo_product_evidence_link`

- Connection, `Ordered Product` event, matched `Placed Order` event, and Shopify order.
- Deterministic association method, status, matcher version, and reason codes.

An `Ordered Product` event can contribute to an order only through an explicit order identifier or an approved provider unique-ID rule. Profile, timestamp, amount, and product similarity cannot attach it. This keeps the per-unit product events subordinate to the one-per-order conversion match.

#### `klaviyo_attribution_claim`

- Conversion-event reference and Klaviyo attribution ID.
- Nullable attributed-interaction event reference or external ID.
- Nullable campaign, flow, message, and variation object references.
- Nullable interaction metric/type, timestamp, channel, sanitized host/path, and bot-click indicator.
- Fetch timestamp and API revision.

These rows state what Klaviyo attributed; they do not state what Adsolute or Shopify concluded.

### 8.4 Advisory and operational records

#### `shopify_evidence_sync_run`

- Organization, Shopify store, requested half-open window, opaque cursor, and status.
- Protected-identity capability state and order-line completeness state.
- Read, enriched, partial, unavailable, warning, and failure counts.
- Sanitized error plus started/finished timestamps.

This run is independent of the existing monetary Shopify sync run. Its failure cannot change the success state of order/refund ingestion.

#### `shopify_evidence_run_observation`

- Exact Shopify evidence run and scoped order membership.
- Complete/preserved-partial line disposition and available/unavailable/not-refreshed/suppressed identity disposition.
- Immutable identity-free checksum of the exact matcher-visible order/line snapshot committed with that run.

An optional `shopify_evidence_run_identity_observation` links that exact run/order to the immutable current-version HMAC row used, but stores no digest or digest-derived checksum. Klaviyo runs use the analogous content observation plus `klaviyo_event_run_identity_observation`. Same-digest replay reuses a source/version HMAC row ID; a changed digest replaces the row and cascades dependent identity observations. The content observation, optional identity link, evidence writes, and per-order/page checkpoint commit atomically. A later failed refresh cannot donate mutable content or identity to an older acceptable run. Matching reads both sources only through their exact bound observations, validates current identity-free content, and uses actual HMACs transiently only after following an unchanged current-version identity link.

#### `klaviyo_match_run`

- Connection, exact Shopify evidence-run ID, exact order-core Klaviyo source-run ID, and evaluated Shopify/event half-open windows.
- Matcher version plus separate canonical Shopify-evidence and Klaviyo-source checksums built from identity-free content observations and opaque identity-row/link IDs plus version labels—never HMAC values or digest-derived verifiers.
- Approved-rule/configuration checksums, logical publication-scope fingerprint, and canonical invocation fingerprint.
- Status, start/finish timestamps, publication timestamp, and superseded timestamp.
- Counts for Shopify orders, `Placed Order` events, candidate edges, results, warnings, and failures.

A run is the atomic publication boundary. Only a completed run can publish results for its evaluated entity set. Publication locks the scoped Shopify store and Klaviyo connection in a fixed order, revalidates both exact run memberships/current-equals-observed projections and the full fingerprint, then makes new order/event results current in one transaction. It supersedes predecessors for every directly evaluated entity **and closes selected/dependent incident edges**: replacing an order supersedes any current event conclusion selecting it, and replacing an event supersedes any current order conclusion selecting it, including duplicate-event fan-in. This prevents contradictory cross-run current endpoints. No synthetic result is inserted for an outside-window counterpart; the order/event read model instead returns API-only `not_evaluated` with `incident_edge_boundary`. A new inside-window `no_klaviyo_event` or `unmatched` result carries the same boundary caveat and is worded as window-relative. A nonempty run receives `superseded_at` only after none of its order or event results remains current, so a partially overlapped 90-day run may continue to own genuinely untouched entities. A shared locked recount applies after publication, erasure, and key prune. A valid empty publication has exact zero expected/result/candidate membership and remains fresh with no result rows until a later publication of the same logical scope supersedes it. A partial computation never changes the current view, and a later source mutation makes the publication visibly stale until recomputation.

#### `klaviyo_match_candidate`

- Match run, Shopify-native `Placed Order` event, and Shopify order.
- Candidate class (`deterministic` or `diagnostic`) and match method.
- Normalized feature vector, tolerances, weights, score, and reason codes.
- Created timestamp.

The run plus event plus order is unique. These are candidate edges, not conclusions.

#### `klaviyo_event_match_result`

- Match run and exactly one in-scope Shopify-native `Placed Order` event.
- Status: `confirmed`, `candidate`, `ambiguous`, or `unmatched`.
- Nullable selected candidate edge, candidate count, duplicate-event warning, and reason codes.
- Publication timestamp, nullable supersession timestamp, and nullable closed supersession reason (`entity_replaced`, `incident_edge_boundary`, `rotation_key_retired`, or `privacy_erasure`). The reason is null exactly when the timestamp is null.

A confirmed event result references exactly one deterministic candidate. A candidate result references exactly one unique top diagnostic edge but remains unconfirmed. Ambiguous references no selected edge and retains all tied/conflicting candidates. Unmatched has no candidate edges.

#### `klaviyo_order_match_result`

- Match run and exactly one Shopify order inspected inside the run window.
- Status: `confirmed`, `candidate`, `ambiguous`, `no_klaviyo_event`, or `duplicate_conversion_events`.
- Nullable selected candidate/event, product status, claim counts, and reason codes.
- Matcher version, publication timestamp, nullable supersession timestamp, and the same closed reason with the same null-pair invariant.

This order-anchored result distinguishes “Shopify order was evaluated and no Klaviyo event was found in this window” from “not evaluated.” Duplicate native `Placed Order` events may each resolve to the same order, but the order result becomes `duplicate_conversion_events` and never silently chooses one claim chain as canonical. Partial unique indexes and transaction checks enforce one current order result per connection/order and one current event result per connection/event. Candidates remain immutable historical edges and are exposed only when reachable through the exact requested entity's current result. Claim ingestion revalidates full dual-source publication freshness, the exact unsuperseded event result, and the gate/store-policy/environment key binding before each provider request and again at commit. Only a confirmed event's same-run/same-edge unsuperseded order result may receive canonical attachment or `claimCount`; current unmatched/ambiguous/candidate events—including noncanonical duplicate conversion events—may retain provider claims only in diagnostic/unmatched views.

#### `klaviyo_report_generation`

- One scoped staging/current/failed/superseded generation per report kind and report sync run.
- A logical publication-scope fingerprint excluding refresh `asOf`, plus an exact refresh fingerprint including it.
- Requested range, account timezone, safe counts, and publication/supersession timestamps.

Only one generation is current per connection and logical report slot. Multi-kind refreshes publish all affected slots atomically; a single-kind refresh replaces only that kind. Failed staging data never mixes with the prior current generation.

#### `klaviyo_report_fact`

- Connection, report type, conversion metric, and marketing-object references.
- Requested start/end range and Klaviyo account timezone.
- Grouping dimensions and request fingerprint.
- Typed core statistics such as conversions, conversion value, recipients, unique clicks, and unique opens.
- Allowlisted additional statistics, API revision, and fetch timestamp.

Report facts are aggregate claims and cannot participate in order matching.

#### `klaviyo_sync_run`

- Connection and operation kind (`discovery`, `probe`, `dimensions`, `events`, or `reports`). Matching owns terminal `klaviyo_match_run` rows and Trigger invocation state rather than overloading this source-sync table.
- Requested window, cursor/checkpoint, API revision, and status.
- Read, inserted, updated, ignored, warning, and failure counts.
- Sanitized error code/message plus started/finished timestamps.

Previous source data remains available when a later run fails.

All source-child, claim, evidence-link, candidate, and result foreign keys have explicit cascade behavior from organization/store/connection and their immediate source parent. Existing Shopify orders, refunds, monetary sync runs, and nullable-store findings also use their full organization/store parent scope rather than an independently mutable store ID. Checks enforce exactly-one polymorphic source reference, positive quantities, valid status combinations, and confidence bounds. Query indexes cover store/customer ID, versioned HMAC digest, event metric/time/profile, order/product/variant/SKU, marketing-object external ID, current result lookup, and report request freshness.

This requires closing both deletion and tenant-scope gaps before pilot identity collection: run the fail-closed preflights before any migration mutation, add `shopify_store.organization_id -> organization.id` with `ON DELETE CASCADE`, replace the four legacy unscoped foreign-key paths, and cover organization/store/order/run deletion with integration tests against the actual migration artifact. Pilot customer/profile identity ingestion remains disabled until that migration is applied.

## 9. Synchronization design

### 9.1 Pilot stages

1. **Connection validation** — require the private key and HMAC secret, call Accounts, verify the discovered account ID against the explicit Reviv binding, and ensure that account is not active on another store connection.
2. **Shopify evidence readiness** — run a separate 90-day enrichment backfill for existing Shopify orders, complete order lines first, and add limited identity only when the capability probe succeeds. Record complete, partial, and unavailable coverage without touching monetary fields.
3. **Metric discovery** — enumerate metrics and resolve the unique Shopify-native order metrics plus the allowed journey metrics.
4. **Small live probe** — inspect 20–50 recent Shopify orders and corresponding Klaviyo events. Persist property shapes, identifier coverage, collisions, normalization rules, product coverage, unmatched examples, and approval decisions.
5. **Order-core event backfill** — after the probe gate passes, ingest the approved 90-day `Placed Order` and `Ordered Product` window in bounded chunks with cursor pagination and attribution relationship IDs included.
6. **Advisory matching** — compute and atomically publish a versioned result only after source writes for the evaluated window complete.
7. **Claims and dimensions** — after order linkage is measurable, fetch campaigns by channel and traverse flows through actions and messages. Fetch tracking settings. When a claim points to an interaction event, fetch that referenced event by ID through the same Events API and pass it through the allowlist/redactor. If its metric is outside the allowed families or the event is unavailable, retain only the relationship ID and render interaction details as unknown. Flow-message variations are normalized as marketing objects only when the live API relationship proves a stable external ID; otherwise the redacted claim retains a nullable external variation reference.
8. **Journey and report enrichment** — ingest the remaining approved journey metrics and fetch campaign/flow aggregate reports through a separate, heavily throttled queue, using the discovered Shopify-native `Placed Order` metric as the explicit conversion metric.
9. **Incremental refresh** — refresh new data and re-fetch the trailing seven days because Klaviyo attribution can settle or be recalculated after the conversion.

The pilot exposes a manual sync immediately. A daily incremental schedule may be enabled only after the live probe passes and the full backfill completes successfully. The 90 days define the initial retrieval boundary, not automatic retention: forward incremental records remain available for the duration of the pilot, so the stored span can grow beyond 90 days. Expansion beyond Reviv requires a separate retention decision.

### 9.2 Idempotency and checkpoints

- Source rows upsert on connection-scoped provider IDs.
- A cursor/checkpoint advances only after the corresponding page is normalized and committed.
- A retry can replay a page without creating duplicates.
- An interrupted run resumes at its last committed checkpoint.
- Re-fetching the trailing window creates immutable per-run Shopify/Klaviyo observations and writes a new matching version when either exact run/membership/checksum, approved join rules, matcher version, or scoring configuration changed.
- Missing rows in a failed or partial response never cause deletion.
- Shopify order-line ingestion uses replace semantics per successfully fetched order; the write, observation, and checkpoint are one transaction.

Time windows are half-open UTC intervals `[from, to)` and are converted to account/store-local dates only for display and reporting semantics. Overlapping trailing refreshes are expected and safe. Persist only opaque cursor tokens; a followed pagination URL must use HTTPS and the exact expected Klaviyo API host.

The Trigger.dev project currently has a 600-second task limit. A 90-day source operation is therefore a supervisor plus resumable bounded child batches (or self-triggered continuations), not one long-running task. Every child commits its own page/window checkpoint before scheduling the next.

### 9.3 Rate limits

The API client honors `Retry-After`, uses bounded exponential backoff with jitter for retryable failures, and caps concurrency per endpoint family. Campaign/flow reporting uses a separate queue because its quota is substantially lower than event retrieval. Each report kind has a logical publication slot whose fingerprint excludes refresh `asOf`, while an exact refresh fingerprint includes API revision and `asOf`. Scheduled refresh preflight skips fresh slots before creating staging state; manual full-window refresh always creates a new refresh fingerprint and atomically replaces the affected current slot after success. Thus caching never suppresses legitimate recalculation or publishes an empty staging generation.

## 10. Matching and explanation policy

### 10.1 Candidate scope and normalization

Candidates are generated only inside one organization, Shopify store, and Klaviyo connection.

- Shopify GraphQL order GIDs may be canonicalized only by recognizing the exact `gid://shopify/Order/<id>` structure.
- Shopify order ID and human-facing order name/number remain separate namespaces.
- Provider strings are trimmed; arbitrary punctuation or digits are not stripped to force a match.
- Email normalization is `trim` plus lowercase only. Provider-specific rewriting, Gmail dot removal, and fuzzy email comparison are forbidden.
- Product and variant IDs use recognized Shopify GID normalization where applicable; SKU comparison is exact after surrounding whitespace is removed.

Every normalization rule is versioned with the matcher.

### 10.2 Evidence ladder

1. **Confirmed by explicit order ID** — a documented or live-validated Klaviyo order property equals the canonical Shopify order ID within the same store.
2. **Conditionally confirmed by provider unique ID** — a provider unique-event field may become a confirmed rule only after the Reviv probe demonstrates its structure, uniqueness, and deterministic mapping. It is disabled by default because the native Shopify mapping is not guaranteed by public documentation.
3. **Product validation** — after an order match exists, compare Shopify order lines with Klaviyo product observations using variant ID as the exact key; product ID and SKU provide explicitly qualified supporting evidence.
4. **Diagnostic candidate** — identity HMAC, timestamp proximity, amount proximity, and product overlap may rank or explain candidate orders. No combination of these signals can produce `confirmed`.
5. **Ambiguous or unmatched** — multiple deterministic candidates remain ambiguous; zero deterministic candidates and zero eligible diagnostic candidates produces unmatched. The system never picks one silently.

A confirmed result always has confidence `1.0` because its approved deterministic key resolves uniquely. Matcher v1 diagnostic candidates must be in the same store and within 24 hours of Shopify `orderCreatedAt`, and must have either an exact tenant-scoped email HMAC or product overlap. The transparent default score is:

- Exact email HMAC: 4 points.
- Exact variant multiset: 4 points; partial variant/product overlap: 2 points.
- Absolute time difference at most 5 minutes: 3 points; at most 1 hour: 2 points; at most 24 hours: 1 point.

A candidate needs at least 5 points. Its displayed confidence is `min(score / 11, 0.99)`. Klaviyo value and Shopify Net sales have different semantics, so amount scoring is disabled by default. A later approved matcher version may add an exact currency/minor-unit amount feature only after the probe identifies comparable source fields and records its tolerance/weight.

A unique highest diagnostic score produces `candidate`; a tied highest score produces `ambiguous`; no eligible candidate produces `unmatched`. Conflicting deterministic keys also produce `ambiguous` regardless of diagnostic score. The stored candidate edge contains every feature, tolerance, weight, score, and tie so the result is reproducible. Diagnostic score can never bypass the deterministic confirmation rule.

### 10.3 Product comparison

Expected quantities form a Shopify multiset. Klaviyo `Ordered Product` events are counted as unit observations only when their association to the order is explicit or governed by an approved rule. If a matched `Placed Order` contains a usable item array, it may be used instead. The two sources are never summed together.

Diagnostic candidate edges may calculate product overlap to explain/rank a candidate, but a published order-level product status is assigned only after the `Placed Order` result is confirmed. Candidate and ambiguous views show per-edge overlap without presenting it as a concluded product match.

Variant ID is the only identifier that can independently establish an exact variant match. Product ID alone establishes product-family agreement and is at most `partial` when variant-level disambiguation is missing. SKU contributes only when the same records also show it is unambiguous for the compared lines; the pilot does not infer store-wide SKU uniqueness from a 90-day sample. Duplicate keys are compared as multisets with quantities, not as sets.

Product status meanings:

- `exact` — every comparable unit agrees by normalized variant ID and quantity.
- `partial` — at least one comparable product agrees, with missing evidence on either side.
- `contradictory` — comparable identifiers or quantities disagree.
- `unavailable` — no defensible product association or comparable key exists.

No product status changes order revenue or creates product revenue.

### 10.4 Attribution claims

`include=attributions` supplies the attribution resource/relationship ID; the live probe must verify which interaction, campaign, flow, message, and variation relationships the pinned API revision actually exposes. Only proven nullable relationships are normalized. An unavailable relationship remains `unknown` rather than being reconstructed from aggregate reports or names. When the claim resource itself supplies an approved coarse type, the UI may distinguish click, open, delivery, SMS, and onsite evidence; event details outside the allowed families remain unknown and are not ingested. Missing interaction URLs remain missing; open/delivery attribution is never rendered as a click. A bot-click warning appears only when that nullable property is actually available.

Claims attach to the Klaviyo conversion event and, through the advisory match, become inspectable beside the Shopify order. They never update the order's last-click fields or bucket.

### 10.5 Journey construction

An order journey is anchored to a matched Klaviyo `Placed Order` event. The directly attributed interaction is included in the chronological journey only when it was also canonically ingested as a journey event; otherwise it remains separately labelled claim detail. Additional approved events are included only when they share the exact Klaviyo profile relationship ID, occur before or at the conversion, and have a current-equals-observed membership in a successful canonical journey run. Overlapping 90-day and trailing-seven-day runs select the latest successful observation per event; partial/failed observations cannot become timeline evidence. The default lookback is 30 days, with 7/30/90-day controls bounded by successful ingested coverage. Events are labelled **same Klaviyo profile**, not proven actions by a Shopify customer. HMAC similarity never extends a journey across Klaviyo profile IDs, and profile merging is shown as a source caveat.

### 10.6 Aggregate reports

Campaign and flow report facts are displayed in a separate report view. They are grouped according to Klaviyo's account timezone and message-send-date semantics, not Shopify order-occurrence time. They cannot be joined to or reconciled as individual orders.

## 11. Pilot API and playground

### 11.1 Route and authorization

The new page lives at `/attribution/klaviyo`. The existing `/attribution` route and ledger stay unchanged. During the pilot, only organization owners/admins can read the playground or invoke sync/recompute actions. This matches the sensitivity of pseudonymous identity and source evidence; member access requires a later privacy review.

A privileged **Klaviyo Lab** link in the attribution header makes the route reachable. This is the only required change to the existing attribution surface; its ledger, calculations, buckets, and drill-down behavior do not change.

The tRPC surface should provide focused procedures equivalent to:

- Connection health and recent sync runs.
- Probe report, candidate join rules, and explicit approve/reject actions.
- Coverage summary for a Shopify date range.
- Paginated Shopify-order-first rows with filters.
- One order's explanation, products, journey, claims, and inspector data.
- Paginated unmatched Klaviyo order events.
- Campaign/flow report facts.
- Explicit manual sync and match recomputation mutations.

All browser-facing procedures use `orgAdminProcedure` (or its repository-equivalent owner/admin guard) and derive organization scope from the authenticated session; callers never provide an authoritative organization ID. Background workers call internal service entry points rather than session-oriented tRPC procedures.

### 11.2 Page structure

The header shows connection health, last successful sync, covered date range, stale status, and manual refresh/recompute controls. A probe panel shows sampled order count, property-shape coverage, collisions, incomplete Shopify access, and the current approved/rejected join rules before broader data is enabled.

The coverage section visualizes:

- Shopify orders inspected.
- Confirmed, candidate, ambiguous, no-Klaviyo-event, duplicate-conversion-event, and not-yet-evaluated Shopify coverage.
- Confirmed, candidate, ambiguous, unmatched, and API-only not-evaluated Klaviyo `Placed Order` event coverage, with incident-boundary counts/caveats shown separately.
- Exact, partial, contradictory, and unavailable product evidence.
- Orders with campaign/flow claims.
- Stale or failed source stages.

The main table starts with Shopify order, date, Net sales, current production bucket, and purchased products. Klaviyo columns follow with order status, product status, channel, campaign/flow/message, and evidence warnings. Filters cover date, order status, product status, claim type, channel, and current Shopify bucket.

### 11.3 Order detail

1. **Explanation** — matcher version, method, confidence, evidence used, normalization, candidate count, and mismatch reasons.
2. **Products** — Shopify lines beside the selected Klaviyo evidence source, with product, variant, SKU, and quantity differences highlighted. Shopify Net sales remains a single order value.
3. **Journey** — only approved events, in chronological order from product activity through checkout, message interaction, and conversion.
4. **Claims** — interaction → message → campaign/flow → conversion, with advisory labelling and bot/open/delivery caveats.
5. **Inspector** — normalized fields beside stored redacted evidence and the key/type fingerprint.

The inspector never makes a live unrestricted-raw request. It also never exposes the existing raw Shopify `customerJourney` JSON, whose landing/referrer URLs may contain sensitive query values; only a newly sanitized projection is available. Full identity HMACs, Klaviyo profile IDs, and secrets are not rendered. Event, campaign, flow, and message IDs may be copied by privileged users for source debugging; identity IDs remain masked.

A separate unmatched-events view exposes current non-confirmed Klaviyo order events plus event-left-joined `not_evaluated` boundary rows. It shows an event-status column and warns that a Shopify counterpart may exist outside the evaluated window; it never relabels that state `unmatched` or claims global absence. A separate reports view prevents aggregate campaign/flow claims from being confused with order reconciliation.

## 12. Privacy and security

### 12.1 Environment configuration

The pilot requires server/worker-only values equivalent to:

- `KLAVIYO_PRIVATE_API_KEY`
- `IDENTITY_HMAC_SECRET`
- `IDENTITY_HMAC_KEY_VERSION`
- `IDENTITY_ERASURE_HMAC_SECRET`
- `IDENTITY_ERASURE_HMAC_KEY_VERSION`

During a planned rotation only, the server/worker may also receive previous-secret and previous-version variables. They are absent during normal operation. On success they are removed only after retained-source sweep, new publication, and database-prune proof complete. On a rollback-safe prepublication abort—or an abandoned validation failure before dual—the old values are first promoted from previous back to ordinary current variables, the abandoned new secret plus previous variables are removed, and writers remain disabled until the registry/policy/gate readiness check passes. A pre-dual failure may instead be corrected and retried with the exact intended rotation pair.

The optional rotation variables are added to `.env.example` beside the required pilot variables, with comments that prohibit client-side exposure.

The matching HMAC master secret is independent from authentication secrets, API-key hashing secrets, Shopify credentials, worker secrets, and the erasure-suppression secret. Both HMAC secrets contain at least 32 random bytes. `encodeIdentityScope(scope)` is the internal (not stable public export) canonical scope primitive:

```ts
function encodeIdentityScope(scope: IdentityScope): string {
  assertWellFormedIdentityScope(scope);
  const organizationLength = Buffer.byteLength(scope.organizationId, "utf8");
  const storeLength = Buffer.byteLength(scope.storeId, "utf8");
  return `scope-v1:${organizationLength}:${scope.organizationId}:${storeLength}:${scope.storeId}`;
}
```

The matching tenant key is `HMAC-SHA256(matching-secret, "identity-tenant:" + encodeIdentityScope(scope))`; the suppression tenant key is `HMAC-SHA256(suppression-secret, "identity-erasure-tenant:" + encodeIdentityScope(scope))`. Scope components are arbitrary well-formed Unicode / PostgreSQL-representable text: empty components, colons, controls other than U+0000, and multibyte text are accepted, while U+0000 or a JavaScript string containing an unpaired UTF-16 surrogate is rejected before `Buffer.byteLength` or derivation. No Unicode normalization occurs. The canonical `scope-v1` grammar uses UTF-8 byte lengths as unsigned ASCII decimal with no leading zero except `0`, delimiting both components unambiguously. Every HMAC context string is UTF-8. The email digest remains `HMAC-SHA256(matching-tenant-key, "email:<key-version>:<normalized-email>")`; suppression retains its distinct email/customer/profile subject domains and current-then-previous matching output ordering is unchanged. Equal emails in different organizations/stores therefore cannot produce a globally correlatable digest. Only null or absent suppression subject fields are omitted. A present blank/whitespace email is trim-and-lowercase normalized, then HMACed; matching `email: string` has no blank rejection. Shopify customer/profile aliases are exact opaque strings—including whitespace when present—and are neither normalized nor trimmed before their domain HMAC.

Current and previous matching secrets must decode to different byte sequences even when their version labels differ. The suppression root secret must decode to a byte sequence different from every configured matching root (current and previous); both comparisons use the same equal-length `timingSafeEqual` helper (different lengths return false). Configuration and use fail closed before returning key checks or doing identity-bearing work when any root material is reused. Domain separation remains mandatory despite this root-material independence. The separate suppression key remains stable for the lifetime of retained tombstones because erased plaintext is unavailable for automatic re-keying; changing it requires an explicit compliance migration/upstream-deletion process.

### 12.2 HMAC rotation

Stored child rows carry a matching-key version. The store lifetime key registry plus locked `identity_crypto_policy` and `klaviyo_connection` write gate are joint authority: `current_only` emits only their matching stored current label/check even if previous environment variables still exist, while `dual` requires and emits their exact current/previous pairs. Fixed-context HMAC key checks detect same-label secret drift without storing subject data, including reuse after prune/uninstall. Matching compares only the gate's current version inside the same tenant/store; the previous version exists only for rollback and complete erasure. The stable erasure-suppression key is outside this rotation.

Rotation is a durable one-live-graph workflow. Preparation locks store then connection, validates the old registry/policy/gate against the environment previous label/check, insert-or-loads the proposed new lifetime binding (rejecting any historical same-label/different-check), and atomically switches **both** active policy and gate to `dual(current = new, previous = old)` while materializing every retained Shopify-order and Klaviyo-event source carrying the old version, including journey-only records and records outside the current 90-day match window. Each membership has a stable opaque snapshot ID and partial live-source uniqueness. Privacy erasure, ordinary writers, and rotation batches convert a suppression-hit member—including an unavailable live-reference state—to `suppressed` with its exact durable tombstone **before** clearing/deleting source identity; suppression is acceptable coverage, while a merely unavailable source blocks prune. Compliance release is blocked during a nonterminal rotation; after terminal state it converts historical suppressed memberships to non-identifying `released` receipts before deleting the tombstone. Bounded by-ID workers re-fetch sparse identity for the stable set while gate-aware dual-key ordinary writes cover newly arriving rows. Ordinary writers preflight registry/policy/gate/environment immediately before identity-bearing requests and revalidate at commit, so disabled/uninstalled/key-drift states make no protected call or identity write.

After global coverage proves every nonsuppressed old-version source also has the new version, the workflow creates an append-only publication attempt: a fresh ordinary Shopify evidence window, fresh order-core Klaviyo window, and match bound to both exact observation sets/checksums. If an ordinary dual writer or tombstone-proven erasure changes membership/projection after any source ID is fixed—before, during, or after match publication—the attempt becomes stale and the same graph rewinds through all three stages with a new bounded attempt number and distinct durable child IDs/keys; history is never overwritten. Failures after the dual transition leave the graph nonterminal and recoverable. An operator may abort only before any new-key publication and only after proving every new row has its old counterpart; one locked transaction removes rollback-safe new rows and restores both policy/gate to old current-only. Writers then remain deliberately fail-closed until the operator promotes the old previous secret/version back to the ordinary current environment variables, removes the new/rotation variables, and passes a constant-time lifetime-registry/policy/gate readiness check. After publication, recovery through prune is mandatory.

Before pruning, older current **results** outside the rematch window whose explanation uses the old label are superseded and become visibly stale/not evaluated; candidate edges remain immutable history and are reachable only through exact current incident results. One store-then-connection transaction revalidates the complete membership/tombstones, current publication attempt, and both source projections, atomically switches both policy and gate to `current_only(current = new, previous = null)`, supersedes affected results, deletes old-version digest rows while retaining lifetime bindings, recounts affected run currentness, and completes the graph. Any unavailable source or failed proof prevents deletion and leaves policy/gate dual for exact-graph recovery. A writer blocked behind prune reads `current_only` and cannot reinsert an old row even while old environment variables remain. A previous environment secret is removed only after either the completed graph plus current-only bindings or a completed uninstall receipt whose retirement child names that noncurrent version plus current-only store policy proves the new binding, and an independent scoped query finds zero digest rows for it. Uninstall copies distinct noncurrent completed-rotation retired labels even when it occurs after prune, so deleting the graph does not erase the proof. A missing graph/receipt or receipt without that version child is insufficient; plaintext is never retained to make rotation easier.

### 12.3 Data minimization

- Parse and redact before database writes and application logs.
- Never persist or return the private key.
- Never request full profiles for the pilot.
- Never persist plaintext email, phone, name, address, IP address, or unrestricted URL/query values.
- Treat profile IDs and HMACs as pseudonymous personal data, not anonymous data.
- Sanitize errors, request metadata, and observability attributes.
- Do not include source payloads or HMAC values in test snapshots.
- Cap stored allowlisted property JSON at 64 keys, depth 3, and 16 KiB after serialization; cap fingerprints at 128 hashed/approved keys. Truncation produces a visible warning.
- Do not automatically delete historical pilot records; retention is a post-pilot decision. The connector still never requests pre-window history during the initial backfill.
- Retention never overrides deletion. Organization/store deletion cascades through every Shopify/Klaviyo source, identity, suppression, claim, report, candidate, and result row. Klaviyo connection uninstall locks store then connection, deletes all connection-scoped Klaviyo records/digests/rotation graphs, and clears Shopify pilot identity while retaining non-identity order truth/lines and store suppression rows. If rotation left policy/gate dual, the same transaction clears both source families and normalizes the store policy to its already-bound dual-current label/check with previous null. Every uninstall writes a non-subject store-owned completion receipt and retirement children for the gate previous label plus completed-rotation previous labels before deleting the connection, so neither a connectionless dual policy nor prune→uninstall sequencing can strand reinstall/secret-retirement proof; reinstall still must prove the matching environment key check. Digest deletion cascades every exact-run identity-observation link, while identity-free content observations may remain as non-personal lineage and make any dependent publication stale. A store-scoped data-subject erasure path computes every currently stored/configured matching-key version in memory—including both versions during rotation—uses matching digest rows to locate orders/events, derives stable suppression HMACs for email and known customer/profile aliases, and upserts those tombstones before it clears `shopify_customer_id` and removes matching identity plus associated Klaviyo event evidence. Before event/candidate cascades it supersedes every selected, candidate, ambiguous, or duplicate-fan-in incident order conclusion with `privacy_erasure`, then recounts all affected match runs, so deletion cannot leave a current conclusion with stale candidate metadata. Both scheduled writers check suppressions under store→connection-compatible locks, so historical replay cannot recreate deleted identity/evidence. No supplied identifier, raw alias, matching/suppression digest, or digest-derived verifier reaches logs or an aggregate checksum.

## 13. Failure behavior and observability

| Condition | Required behavior |
| --- | --- |
| Missing credential/HMAC secret | Fail before any remote call or write; connection remains not ready |
| Invalid key or missing scope | Mark the stage failed with a sanitized actionable error; preserve prior data |
| Discovered Klaviyo account differs from the explicit binding | Fail closed; write no source rows |
| Probe cannot substantiate the Reviv store/account association | Keep the connection pending review; block the 90-day backfill |
| Shopify evidence capability/page is incomplete | Preserve monetary sync and prior complete evidence; mark product/identity coverage partial |
| Missing or ambiguous Shopify-native metric | Fail discovery closed; do not guess by name |
| HTTP 429 | Honor `Retry-After`; retry within a bounded budget; checkpoint remains safe |
| Retryable 5xx/network failure | Bounded exponential retry with jitter; preserve previous data |
| Malformed or unexpected property value | Drop the value, add a schema-drift warning/fingerprint, continue safe records |
| Partial page/stage failure | Mark the run partial/failed; never delete missing source rows |
| Attribution/report lag | Re-fetch trailing seven days and show freshness timestamps |
| Matcher rule change | Append a new version and retain superseded explanations |
| No defensible join | Render candidate, ambiguous, or unmatched; never force confirmed |

Sync-run counts and timestamps must make it possible to reconcile fetched, accepted, ignored, warned, and failed records. The UI labels stale data instead of hiding it or presenting it as current.

## 14. Verification strategy

### 14.1 Automated tests

- **Unit:** email normalization, tenant-key derivation, versioned HMAC, URL sanitization, property redaction, key/type fingerprinting, metric discovery, ID canonicalization, evidence ladder/scoring, product-source selection, multiset quantity comparison, and claim labelling.
- **Contract fixtures:** sparse event-profile email include, cursor pagination, attribution relationship IDs, referenced-event fetching, campaign channel filters, flow traversal, rate-limit responses, missing relationships, malformed values, and schema drift.
- **Database integration:** organization/store/connection isolation, scoped uniqueness, durable erasure/reingestion suppression, cascades, idempotent replay, checkpoint resume, complete-only order-line replacement, overlapping publication with incident-edge closure and run recount, exact current claim anchors, immutable candidate edges, explicit order/event supersession reasons, and atomic store-policy/connection-gate HMAC transitions.
- **Task integration:** Shopify evidence failure without monetary-sync failure, hard-timeout continuation, failure after a committed page, trailing-window refresh, matcher-only recomputation, report throttling, stale-data preservation, rotation crash/restart at every phase, projection-change publication rewind, and deterministic recomputation.
- **UI:** confirmed, candidate, ambiguous, unmatched-event, no-Klaviyo-event, duplicate-event, order/event not-evaluated boundary caveats, partial, contradictory, unavailable, stale, empty, loading, and failed states; inspector redaction; and role authorization.

### 14.2 Reviv live-probe gate

Before the 90-day backfill, inspect 20–50 recent orders and produce a probe report containing:

- Exact property names and types for candidate order and product identifiers.
- Coverage for each candidate join field.
- Normalization required for Shopify GIDs, order numbers, variants, and SKUs.
- Collision count and multiple-candidate examples.
- Product and quantity coverage from `Placed Order` versus `Ordered Product`.
- Attribution relationship coverage by campaign, flow, message, variation, and interaction type.
- Unmatched examples with redacted evidence.
- Confirmation that no plaintext identity or unapproved values reached storage or logs.

An undocumented provider unique ID can be enabled as a Reviv-specific confirmed rule only when every populated sample value has at most one Shopify candidate, there are zero collisions, and manual inspection demonstrates a deterministic mapping. Missing coverage is reported, not filled through fuzzy matching.

### 14.3 Pilot acceptance invariants

The pilot is acceptable only when:

1. A before/after integration snapshot proves Shopify order counts, Net sales, refund totals, bucket totals/rule versions, and Meta-verification totals remain exactly unchanged after evidence backfill and matching.
2. Replaying the same source window creates no duplicate source records.
3. Every inspected Shopify order and in-scope Klaviyo order event has an explicit current state.
4. Confirmed matches are reproducible from stored allowlisted evidence and matcher version.
5. Diagnostic-only evidence never produces a confirmed result.
6. Product observations never create allocated revenue or alter order Net sales.
7. Aggregate reports are visibly separated from order-level evidence.
8. No plaintext email, unrestricted URL, secret, full profile, or unapproved raw property appears in the database, API output, logs, or fixtures.
9. Cross-organization, cross-store, and cross-connection joins are rejected by tests and query scope.

The pilot deliberately has no required match-rate threshold. Its purpose is to measure defensible coverage before deciding whether Klaviyo evidence should graduate beyond an exploratory tool.

## 15. Rollout and later decisions

1. Add the isolated Shopify evidence-enrichment path, harden store ownership conflicts, and backfill limited identity/order lines while preserving existing monetary reconciliation.
2. Add the connection/provider boundary, discovery, and redaction path.
3. Run the Reviv live probe and approve or reject candidate identifier mappings.
4. Backfill the approved 90-day window and compute advisory matches.
5. Enable the order-first match/product playground.
6. Add approved claim relationships, journeys, and aggregate reports after core linkage coverage is visible.
7. Enable daily incremental refresh only after the backfill and freshness behavior are verified.

Post-pilot decisions, informed by measured evidence rather than assumptions:

- Whether any undocumented unique-ID mapping is stable enough to support more merchants.
- Whether and how long to retain source evidence.
- Whether to add OAuth and self-service multi-store connections.
- Whether additional event families or property aliases are justified.
- Whether any Klaviyo claim should influence a future attribution model. Such a change requires a separate design and cannot happen implicitly from this pilot.
- Whether product economics can ever be allocated defensibly; it remains out of scope here.

## 16. Official references

- [Accounts API](https://developers.klaviyo.com/en/reference/get_accounts)
- [Metrics API overview](https://developers.klaviyo.com/en/reference/metrics_api_overview)
- [Events API overview](https://developers.klaviyo.com/en/reference/events_api_overview)
- [Get Events and attribution relationships](https://developers.klaviyo.com/en/reference/get_events)
- [Shopify data synced to Klaviyo](https://help.klaviyo.com/hc/en-us/articles/115005080447)
- [Campaigns API](https://developers.klaviyo.com/en/reference/get_campaigns)
- [Flows API](https://developers.klaviyo.com/en/reference/get_flows)
- [Reporting API overview](https://developers.klaviyo.com/en/reference/reporting_api_overview)
- [Tracking Settings API](https://developers.klaviyo.com/en/reference/get_tracking_settings)
- [Klaviyo attribution behavior](https://help.klaviyo.com/hc/en-us/articles/1260804504250)
- [Rate limits and error handling](https://developers.klaviyo.com/en/docs/rate_limits_and_error_handling)
- [API authentication](https://developers.klaviyo.com/en/docs/authenticate_)
- [Shopify protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data)
- [Shopify Order API and historical-order access](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order)
