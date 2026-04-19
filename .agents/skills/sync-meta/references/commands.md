# Commands

Use the repo CLI instead of hand-assembling API requests.

## Sync all Meta-enabled accounts

```bash
bunx tsx cli/src/index.ts meta-sync sync
```

## Force a resync for the default window

```bash
bunx tsx cli/src/index.ts meta-sync sync --force
```

## Sync a custom window

```bash
bunx tsx cli/src/index.ts meta-sync sync --date-from 2026-04-01 --date-to 2026-04-20
```

## Sync one account

```bash
bunx tsx cli/src/index.ts meta-sync sync --account-id acct_123
```

## Inspect recent runs

```bash
bunx tsx cli/src/index.ts meta-sync history --limit 20
```
