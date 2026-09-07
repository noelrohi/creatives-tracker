# Klaviyo OpenAPI parity implementation plan

> Completed plan for the superseded live-read implementation. The current target is `../specs/2026-09-07-klaviyo-postgres-snapshots-design.md`; these checkmarks do not indicate that snapshot storage is implemented.

Approved spec: `../specs/2026-09-07-klaviyo-openapi-parity-design.md`.
Results: `docs/klaviyo-parity-matrix.md`, Round 3.

## Round 1: provider contracts

- [x] Add isolated bounded read transport. Kept existing client unchanged because live reads need byte/deadline limits and different request/response contracts; reused its fixed-origin, sanitized-error and cursor-validation approach.
- [x] Implement campaigns/messages, metric catalog and selected-metric event pages, reviewed projections and request-bound continuations.
- [x] Implement campaign values with 17 statistics, explicit conversion metric and account-local report-window metadata; inspect primary report documentation.
- [x] Verify fixtures, minimization, limits and continuation/error behavior; rerun existing regression baseline.

## Round 2: OpenAPI

- [x] Add server-derived org/connection credential service, lifecycle checks and safe errors.
- [x] Compose four org/read-authorized query procedures with closed schemas and OpenAPI metadata.
- [x] Verify actual adapter requests, generated contracts, auth/scope isolation and unchanged admin gates.
- [x] Document usage and limitations in OpenAPI guide.

## Round 3: closure

- [x] Independently compare implementation against four ecomconn jobs and five record schemas.
- [x] Fix nullable-response, parent-relationship and multi-channel-message gaps; update matrix with evidence and verification outcomes.
- [x] Run unit/regression/component checks, typecheck, lint, build and isolated DB integration tests.
- [x] Reproduce three DB integration failures on untouched pre-implementation code and current code; leave confirmed existing defects unchanged.
- [x] Record live-provider limitations without claiming unexecuted checks passed.

Local result: 1,812 non-integration tests and 156 component tests passed; typecheck/lint/build succeeded with documented existing warnings. Isolated Klaviyo DB tests: 169 passed, 3 confirmed baseline failures.

Live-account certification awaits separate authorization. Report continuation/completeness and exact DST/hour-rounding interpretation remain explicitly unverified. No CLI, new custody/onboarding, export platform, migrations, deployment or secret edits.
