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
# Install dependencies
bun install

# Configure environment
cp .env.example .env   # then fill in the values

# Start Postgres
docker compose up -d db

# Apply migrations
bun run db:migrate

# Run the dev server
bun dev
```

Open [http://localhost:3000](http://localhost:3000).

To run background jobs locally, start the Trigger.dev dev server in a second terminal:

```bash
bun run trigger:dev
```

## Commands

| Command | Description |
| --- | --- |
| `bun dev` | Next.js dev server on port 3000 |
| `bun run build` | Production build |
| `bun run lint` | ESLint |
| `bun test` | Run tests (Vitest) |
| `bun run db:generate` | Generate a Drizzle migration from schema changes |
| `bun run db:migrate` | Apply migrations |
| `bun run db:studio` | Open Drizzle Studio |
| `bun run trigger:dev` | Trigger.dev local dev server |
| `bun run trigger:deploy` | Deploy Trigger.dev jobs |

Note: `db:push` is disabled by design — always generate a migration with `db:generate` and apply it with `db:migrate`.

## Project structure

- `src/app/(protected)/` — dashboard routes: home, `creatives`, `import`, `mer`, `accounts`, `teams`, `studio` (Image Studio)
- `src/lib/trpc/routers/` — domain routers (ads, ad sets, creatives, campaigns, insights, studio, …)
- `src/schema/` — Drizzle schema files
- `trigger/` — Trigger.dev background jobs
- `cli/` — `adsolute` CLI for API-key-based workflows
- `scripts/` — one-off backfill and ops scripts
- `docs/specs/` — specs for in-flight and planned work

The `@/*` path alias maps to `./src/*`.
