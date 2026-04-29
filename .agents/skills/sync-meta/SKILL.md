---
name: sync-meta
description: Run the Adsolute Meta sync workflow for base and demographic Meta data across Meta-enabled accounts. Use when the user asks to run the morning sync, refresh Meta ad performance, pull demographics, inspect recent Meta sync runs, or force/rescope a Meta backfill.
---

# Meta sync orchestration

Use the repo CLI command to queue the Trigger.dev task instead of hand-rolling API calls. The durable orchestration logic lives in `trigger/meta-sync.ts`; it handles serial execution, freshness skips, retries, poll loops, imports, preview enrichment, and Trigger run metadata.

## Preconditions

- The caller has an org API key.
- At least one ad account in the workspace has a Meta access token.

## Environment

- `ADSOLUTE_API_KEY` is required. Stop and ask the user to set it if it is missing.
- `ADSOLUTE_API_URL` is optional and defaults to `http://localhost:3000`.

## Default action

Run:

```bash
bunx tsx cli/src/index.ts meta-sync trigger
```

This command:

- Queues the `meta-sync` Trigger.dev task and prints the Trigger run id.
- Syncs every Meta-enabled account returned by `listSyncableAccounts`; do not pre-filter by `isStale`.
- Uses the suggested window unless the user specifies `--date-from` and `--date-to`.
- Syncs base, age, gender, country, and device breakdowns in serial order.
- Skips a breakdown if a successful run for the same account and window finished within the last 4 hours, unless `--force` is set.
- Writes per-account history to `account_sync_run`; inspect it with `meta-sync history`.

## Common variants

- Force a resync: `bunx tsx cli/src/index.ts meta-sync trigger --force`
- Sync a custom window: `bunx tsx cli/src/index.ts meta-sync trigger --date-from YYYY-MM-DD --date-to YYYY-MM-DD`
- Sync one account: `bunx tsx cli/src/index.ts meta-sync trigger --account-id <accountId>`
- Inspect recent runs: `bunx tsx cli/src/index.ts meta-sync history --limit 20`

See [commands.md](references/commands.md) for copy-paste examples.

## Rules

- Do not manually reimplement the sync state machine in prompt text.
- Do not run the legacy `meta-sync sync` command unless the Trigger.dev path is unavailable and the user accepts a local fallback.
- If the user wants prod, make sure both `ADSOLUTE_API_URL` and `ADSOLUTE_API_KEY` point at prod.
- If the command reports failures, surface them clearly so the user can decide whether to rerun a specific account or window.

If the CLI command is missing or broken, fix the CLI command instead of expanding this file.
