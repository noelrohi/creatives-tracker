# Adsolute

Ad creative performance tracking for Meta ads. Syncs ad, ad set, campaign, and demographic data from Meta, tracks creative-level performance and MER, and generates new static ad images from briefs via Image Studio.

## Stack

- [Next.js 16](https://nextjs.org) (App Router, React 19, React Compiler) with Tailwind CSS v4 and shadcn/ui
- [tRPC](https://trpc.io) for the API layer
- PostgreSQL with [Drizzle ORM](https://orm.drizzle.team)
- [Better Auth](https://better-auth.com) for auth and organizations
- [Trigger.dev](https://trigger.dev) for background jobs (Meta sync, image generation)

## Getting started

Prerequisites: [Bun](https://bun.sh) and Docker (for the local Postgres database).

```bash
bun install
cp .env.example .env   # then fill in the values
docker compose up -d db
bun run db:migrate
bun dev
```

Open [http://localhost:3000](http://localhost:3000).

To run background jobs locally, start the Trigger.dev dev server in a second terminal: `bun run trigger:dev` (needs `TRIGGER_SECRET_KEY` in `.env`).

Tests run with `bun run test` (Vitest). Schema changes ship as migrations: `bun run db:generate`, then `bun run db:migrate` — `db:push` is disabled by design. The full script list is in `package.json`; architecture notes live in [AGENTS.md](AGENTS.md).

## Project structure

- `src/` — Next.js app: dashboard routes in `src/app/(protected)/`, tRPC routers in `src/lib/trpc/routers/`, Drizzle schema in `src/schema/`
- `trigger/` — Trigger.dev background jobs
- `cli/` — `adsolute` CLI for API-key-based workflows
- `scripts/` — one-off backfill and ops scripts
- `docs/specs/` — specs and rollout notes for shipped and planned work
