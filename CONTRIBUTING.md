# Contributing

Two people ship this repo, mostly through agents. The rules below exist so PRs merge fast and nobody has to read a 100-file diff or debug a broken migration chain.

## PRs

- **Small, focused PRs.** One reviewable change per PR. A multi-week feature is a sequence of PRs merged incrementally (skeleton → data layer → UI → polish), not one drop at the end. If a PR grows past ~500 changed lines of hand-reviewable code, split it.
- **Merge within ~24h.** A PR that can't merge within a day is too big or too contentious — split it or discuss it first. This is what keeps stacks shallow: stacking is fine, but only ever one PR deep, because the base merges quickly.
- **CI must be green** (lint, unit tests, component tests, build, migration guard). CI is the trust gate — reviewers review intent and design, not whether the code runs.
- **Fill in the PR template.** Screenshots for UI changes, video for interactions.
- Non-trivial features: share the plan (issue or doc) before writing the code, so direction is agreed on before there's a diff to argue about.

## Database migrations

Migrations are the one serialization point between us, so they get special rules:

- Always generate with `bun run db:generate`. Never write or rename migration files by hand — the number also lives in `drizzle/meta/_journal.json` and the snapshot chain, and hand-edits desync them.
- **Migration PRs merge first.** If your PR contains a migration, flag it in the description and prioritize getting it merged so the other person can rebase on it.
- Keep migrations in their own small PR when possible (schema + migration, minimal code), so they don't sit unmerged behind UI review.
- If main got a new migration while your branch also has one, follow "Resolving migration conflicts" in [CLAUDE.md](./CLAUDE.md). CI's migration guard will fail the PR until the chain is clean.

## Working with agents

Agent-written code follows the same rules — the agent reads `CLAUDE.md`, so keep repo conventions there. You own what your agent ships: review the diff before opening the PR.
