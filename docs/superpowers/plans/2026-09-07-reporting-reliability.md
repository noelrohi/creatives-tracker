# Reporting reliability implementation plan

Approved design: ../specs/2026-09-07-reporting-reliability-design.md. The referenced writing-plans skill is not installed; this plan follows repository conventions directly.

1. Implement historical leaderboard mode and regression tests in creative router/contracts; preserve defaults.
2. Implement authoritative Meta currency ingestion/account evidence, additive schema change and tests; generate migration centrally after schema changes settle.
3. Implement nullable fulfillment answer plus read-only Shopify conversion availability/source validation and clear sales definitions with tests.
4. Integrate source-window evidence without overstating completeness. Review existing sync records and add only evidence grounded in completed requests.
5. Run focused tests, full checks and independent diff review. Inspect production configuration safely; never expose credential values.
6. Generate/validate migration, open one PR (explicit user-requested size exception), wait for green CI. Apply reviewed additive production migration before merge because deployment workflows do not migrate automatically.
7. Merge and monitor app/job deployment. Execute bounded existing fulfillment backfill and metadata refresh as needed. Repeat original historical questions using production OpenAPI only, recording figures, currencies, availability and limitations.
8. Iterate recoverable failures. Report permission/historical-access blockers honestly; no provisioning changes or fabricated answers.
