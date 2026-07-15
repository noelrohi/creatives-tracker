# API docs fix list — correct & current OpenAPI surface

Assembled from the wayfinder map [Wayfinder: API docs audit — complete & current OpenAPI surface](https://github.com/noelrohi/creatives-tracker/issues/66) (2026-07-15). Inputs: the [surface decision](https://github.com/noelrohi/creatives-tracker/issues/67), the [response-schema drift audit](https://github.com/noelrohi/creatives-tracker/issues/68) (full table: `docs/research/openapi-docs-drift.md` on branch `research/openapi-docs-drift`), and the shared generator convention from the [Studio agent access spec](https://github.com/noelrohi/creatives-tracker/issues/75).

## Problem

The generated OpenAPI doc (`/api/openapi`, Scalar at `/reference`) is for external agents/tools holding org-scoped API keys — but only 25 of its 73 operations document their responses accurately (36 drifted, 12 untyped), seven useful read endpoints are missing, seven internal metaSync worker operations leaked in, and abTest carries dead meta whose declared paths 404.

## Scope

Non-studio surface plus the shared generator change. Studio exposure is a separate implementation from the [Studio agent access spec](https://github.com/noelrohi/creatives-tracker/issues/75). **Docs-only at the behavior level: no resolver's return value or business logic changes.**

## Surface changes

1. **Add house-style meta** (`openApiQueryMeta`) to 7 query procedures:
   - `adCreative.landingPages`, `adCreative.exportAgentRows`, `adCreative.portfolioSummary`, `adCreative.dashboardExport`
   - `performanceLog.demographicBreakdown`, `performanceLog.creativeDemographicBreakdown`, `performanceLog.exportByAccount`
2. **Strip meta from all metaSync procedures** (7 carry it today). Keep their `.output()` declarations and everything else; remove now-unused meta imports. The router stays fully functional over tRPC (UI, Trigger.dev worker, CLI).
3. **Strip the dead meta from all 7 abTest procedures**; delete `EXCLUDED_OPENAPI_ROUTERS` and its filter in `src/lib/trpc/openapi.ts`; remove unused imports.
4. `metaInsights`, `trigger`, `organization` remain meta-less — no changes there.
5. Resulting doc: **73 operations** — adCreative 21, campaign 7, adSet 8, ad 10, performanceLog 9, tag 4, adAccount 5, apiKey 4, team 5.

## Generator changes (`src/lib/trpc/openapi.ts`)

- `getResponseSchema` prefers a procedure's **declared output schema** (`procedure._def.output`) over everything else. Convert with Zod v4 `toJSONSchema(schema, { target: "openapi-3.0", reused: "inline", ... })`, mapping unrepresentable types: `z.date()` → `{ type: "string" }` with an ISO 8601 description (use `unrepresentable: "any"` plus an `override` callback keyed on the Zod def type); a `z.void()`/`z.undefined()` output → `{ type: "null" }` (the REST layer serializes `undefined` as JSON `null`).
- **End state: every documented operation has a declared `.output()`**, so delete the whole legacy schema layer from `openapi.ts`: `customResponseSchemas`, `selectSchemas`, `selectSchema()`, the `creativeListItemSchema`/`creativeGetByIdSchema`/`creativePerformerSchema` locals, the `tag.listForEntity` special case, and the now-unused `drizzle-zod` / `@/schema/*` imports. Keep the untyped-object fallback as a safety net only; the doc-seam test asserts it never fires.
- `TAG_METADATA`: add a `team` entry (name "Teams", description "Manage teams for creative ownership"); leave the rest as is.
- Everything else in the file (input handling, query coercion, dispatcher `callOpenApiProcedure`, security schemes) is unchanged.

## Output-schema conventions (all routers)

- House style per `src/lib/trpc/routers/team.ts`: a named Zod schema next to the router, `z.date()` for timestamp columns, `.nullable()` mirroring the DB, `z.array(...)` for list returns.
- **Schemas describe what the resolver already returns — exactly.** Declaring `.output()` makes tRPC strip unknown keys and throw on mismatch at runtime for ALL callers including the dashboard. Two safety nets, use both: existing router tests (`bun test`) now exercise output validation, and `bun run build` type-checks dashboard usage against the schema-inferred output types. A build/type failure means the schema is wrong or incomplete — fix the schema, never the UI or the resolver.
- **bigint/numeric caveat** (recurring drift-audit finding): SQL `sum`/`count`/numeric aggregates serialize as **strings** via node-postgres — schema them `z.string()` (nullable where the query can return null). Plain JS-computed numbers stay `z.number()`. The drift table flags each case; read it first: `git show research/openapi-docs-drift:docs/research/openapi-docs-drift.md`.
- Procedures returning nothing (the delete family, `tag.detach`) declare `.output(z.void())`.
- Where a router already declares outputs (`account.ts` — `publicAdAccountSchema`; `team.ts`; `meta-sync.ts`), verify against the current resolver and keep; do not duplicate.

## Per-router work

| File | Work |
|---|---|
| `src/lib/trpc/routers/ad-creative.ts` | `.output()` on all 21 procedures; add meta to the 4 gap queries |
| `src/lib/trpc/routers/campaign.ts` | `.output()` on all 7 |
| `src/lib/trpc/routers/ad-set.ts` | `.output()` on all 8 (list shapes carry joined fields: campaignName, accountName, adCount…) |
| `src/lib/trpc/routers/ad.ts` | `.output()` on all 10 (joined subsets, computed effective status, `pauseMetaAds` report shape, `listByCreative` aggregates) |
| `src/lib/trpc/routers/performance-log.ts` | `.output()` on all 9; add meta to the 3 gap queries |
| `src/lib/trpc/routers/tag.ts` | `.output()` on all 4 (`search` returns an array; `listForEntity` returns plain tag rows) |
| `src/lib/trpc/routers/api-key.ts` | `.output()` on all 4 (current custom schemas in `openapi.ts` are accurate — port them) |
| `src/lib/trpc/routers/account.ts` | Verify existing outputs cover all 5 exposed procedures (incl. `delete`) |
| `src/lib/trpc/routers/meta-sync.ts` | Strip meta (keep outputs) |
| `src/lib/trpc/routers/ab-test.ts` | Strip meta |
| `src/lib/trpc/openapi.ts` | Generator change + legacy-layer deletion + `TAG_METADATA.team` + drop `EXCLUDED_OPENAPI_ROUTERS` |

## Testing

- **New doc seam** — `src/lib/trpc/openapi.test.ts` over `generateOpenApiDocument`/`getOpenApiProcedures`: exactly the 73 expected operations (assert the full path inventory); no operation emits the untyped fallback; no `/metaSync/` or `/abTest/` path; the 7 added paths present; every operation carries tags + summary; `team` renders with its tag metadata; `apiKey` operations keep session-only security.
- **Existing suites must pass** — they now exercise output validation; if a test's mocked DB rows lack fields the schema requires, complete the mock rows (the schema is the contract, the mock is the fake).
- Proof for the whole effort: `bun test && bun run lint && bun run build` all green.

## Out of scope

- Studio procedures, scope enforcement, upload endpoint, agent guide, descriptions — all owned by the Studio agent access spec.
- Any change to resolver behavior, tRPC init/context, or the REST dispatcher.
- Prose/examples polish in the docs.
