---
name: sync-meta
description: Run the Adsolute Meta sync workflow for base and demographic Meta data across Meta-enabled accounts. Use when the user asks to run the morning sync, refresh Meta ad performance, pull demographics, inspect recent Meta sync runs, or force/rescope a Meta backfill.
---

# Meta sync orchestration

Use the repo CLI command instead of hand-rolling API calls. The orchestration logic lives in `cli/src/commands/meta-sync.ts`; it already handles serial execution, freshness skips, retries, poll loops, imports, preview enrichment, and summary output.

## Preconditions

- The caller has an org API key.
- At least one ad account in the workspace has a Meta access token.

## Environment

- `ADSOLUTE_API_KEY` is required. Stop and ask the user to set it if it is missing.
- `ADSOLUTE_API_URL` is optional and defaults to `http://localhost:3000`.

## Default action

Run:

```bash
bunx tsx cli/src/index.ts meta-sync sync
```

This command:

- Syncs every Meta-enabled account returned by `listSyncableAccounts`; do not pre-filter by `isStale`.
- Uses the suggested window unless the user specifies `--date-from` and `--date-to`.
- Syncs base, age, gender, country, and device breakdowns in serial order.
- Skips a breakdown if a successful run for the same account and window finished within the last 4 hours, unless `--force` is set.
- Emits the final markdown summary itself.

## Common variants

- Force a resync: `bunx tsx cli/src/index.ts meta-sync sync --force`
- Sync a custom window: `bunx tsx cli/src/index.ts meta-sync sync --date-from YYYY-MM-DD --date-to YYYY-MM-DD`
- Sync one account: `bunx tsx cli/src/index.ts meta-sync sync --account-id <accountId>`
- Inspect recent runs: `bunx tsx cli/src/index.ts meta-sync history --limit 20`

See [commands.md](references/commands.md) for copy-paste examples.

## Rules

- Do not manually reimplement the sync state machine in prompt text.
- Do not parallelize accounts or breakdowns outside the CLI command.
- If the user wants prod, make sure both `ADSOLUTE_API_URL` and `ADSOLUTE_API_KEY` point at prod.
- If the command reports failures, surface them clearly so the user can decide whether to rerun a specific account or window.

If the CLI command is missing or broken, fix the CLI command instead of expanding this file.
