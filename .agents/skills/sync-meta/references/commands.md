# Commands

Use the repo CLI to queue the Trigger.dev task instead of hand-assembling API requests.

## Sync all Meta-enabled accounts

```bash
bunx tsx cli/src/index.ts meta-sync trigger
```

## Force a resync for the default window

```bash
bunx tsx cli/src/index.ts meta-sync trigger --force
```

## Sync a custom window

```bash
bunx tsx cli/src/index.ts meta-sync trigger --date-from 2026-04-01 --date-to 2026-04-20
```

## Sync one account

```bash
bunx tsx cli/src/index.ts meta-sync trigger --account-id acct_123
```

## Inspect recent runs

```bash
bunx tsx cli/src/index.ts meta-sync history --limit 20
```
