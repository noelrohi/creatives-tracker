# Intelligence Luna Model Design

## Goal

Use `gpt-5.6-luna` for all Intelligence v1 AI classification while preserving existing task behavior.

## Scope

Replace the hard-coded `gpt-5.6-terra` model in:

- `trigger/enrich-creative-tags.ts` for creative tagging and ad-set funnel classification.
- `trigger/classify-landing-pages.ts` for landing-page classification.

No schemas, prompts, batching, retries, provider configuration, or task payloads change. Calls continue through `OPENAI_API_KEY` and still consume provider credits.

## Verification

Run TypeScript checks and the relevant enrichment and landing-page tests. Confirm no Intelligence task still references `gpt-5.6-terra`.
