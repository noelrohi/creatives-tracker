# Production reporting reliability

## Goal and approval

The user approved this design on September 7, 2026: fix recoverable reporting gaps in one PR, skip ClickUp, and explicitly report permission blockers rather than inventing data. Shipping, merging, required production migrations, bounded backfills and production OpenAPI retesting are authorized. Shopify permission/provisioning changes are not part of this scope.

Production checks found 4,988 July non-cancelled/non-test Shopify orders with unknown fulfillment status; missing Meta account currencies; no storefront session conversion endpoint; and reporting completeness that cannot be established from recent sync timestamps. Existing leaderboards apply current-active eligibility to historical windows. Existing sales aggregates need explicit source definitions.

## Approach

Prefer targeted changes to existing ingestion, evidence modules and org-scoped OpenAPI routers over a disclosure-only patch or a new analytics platform. Preserve existing response fields and dashboard defaults. Add bounded modules for new source adapters and evidence policies; no unrelated UI changes.

### Fulfillment

Use the existing organization/store-validated, resumable fulfillment backfill to populate missing authoritative statuses. Verify ongoing sync observes status updates. Retain observed counts and status breakdowns; add a nullable answer/availability contract so incomplete classification cannot masquerade as a complete zero. Even fully classified local orders do not establish full Shopify source coverage. Counts select creation dates and describe latest observed status, not historical month-end status. Do not implement retrospective status reconstruction.

### Meta currencies

Fetch authoritative account currency with account metadata and persist a nullable currency. Expose it in safe account responses and account-scoped reporting. Provide explicit uniform/mixed/unknown currency evidence for aggregate amounts. Never infer currency from timezone or Shopify currency, silently convert money, or present an unvalidated mixed-currency sum as spend in a single currency. Preserve legacy response compatibility while making authoritative usability explicit.

### Historical coverage

Expose bounded evidence of successfully fetched source windows and failed or incomplete attempts where the sync can establish those facts. Historical absence of evidence remains unknown. Distinguish transport/query completion, local observations, gap-free source ingestion and attribution finality; none implies the others. Backfill recoverable gaps with bounded resumable jobs, not unbounded retry loops. Include disabled/disconnected accounts and retain null-versus-zero distinctions.

### Historical leaderboard

Add an explicit historical ranking mode that does not require a currently active ad. Preserve current dashboard defaults. Declare ranking metric, eligibility thresholds, applied filters, sample sizes and low-sample warnings. Historical mode ranks observed performance, not reconstructed historical ad status. Use deterministic ordering before LIMIT and consistent qualification/display scopes. Do not promise that small-sample ROAS is a proven winner.

### Sales definitions

Expose source and arithmetic definitions in machine-readable reporting metadata and OpenAPI descriptions: Shopify-derived net sales from order/refund records versus Meta-attributed purchase value versus Shopify-verified attributed revenue. Include population, date basis and relevant currency evidence. Do not claim reconciliation with official Shopify reports without evidence.

### Storefront conversion

Validate existing Shopify access through a minimal aggregate-only source query or granted-scope check without disclosing credentials. ShopifyQL session metrics require reporting access; existing order access is not proof. Expose an org/store-scoped, read-authorized availability result with null numerator, denominator and rate and a specific blocker when unavailable. Never derive sessions from orders or substitute Meta conversion metrics. Return actual session-based conversion only if source access, counts, date/timezone semantics and population can be validated. A known zero denominator yields null, whereas zero conversions with a positive known denominator yields zero. No new credential scopes, app provisioning, or invented historical session data.

## Verification

Test partial/unknown/complete observed fulfillment classification; source-denied and missing session data; currency uniformity, missing currencies and mixed currencies; coverage success/failure/partial semantics; historical versus default eligibility; ranking thresholds, ties and small samples; sales definitions; and org/read-key isolation. Run focused Vitest suites using `bun run test`, typecheck, lint and build as applicable. Use database-backed tests where needed and disclose environmental blockers.

Generate migrations through Drizzle and validate the migration journal; never hand-renumber migrations. Review changes and check CI before merging one PR. Inspect deployment/migration automation before selecting rollout order; apply additive migrations before code that requires their columns, and deploy affected Trigger jobs. Do not alter secrets or bypass protections. Run bounded backfills and preserve operational evidence without credentials or customer data.

## Production acceptance

Repeat read-only OpenAPI checks against the confirmed production host, creatives-tracker.vercel.app:

- Top ten Meta creatives, August 31–September 1, 2026; explicit ranking and historical eligibility.
- August 1–31 Shopify-derived net sales.
- July 1–31 created orders currently observed unfulfilled, excluding cancellations.
- September 1 Meta spend and ROAS by account.
- September 2 Shopify-derived net sales and storefront session conversion availability/value.
- September 2 Meta-attributed revenue and ROAS by account.

Use store/account calendars and explicit currencies. Re-query after each relevant recovery/deployment step. Stop retrying when a confirmed permission, inaccessible historical source, or human-only action blocks further progress; report that blocker clearly. Successful acceptance includes honest unavailable results for irrecoverable or permission-blocked metrics, not fabricated numerical answers.
