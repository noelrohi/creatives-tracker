# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Commands

- **Dev server:** `bun dev` (Next.js dev server on port 3000)
- **Build:** `bun run build`
- **Start:** `bun run start`
- **Lint:** `bun run lint` (ESLint)
- **DB generate:** `bun run db:generate`
- **DB migrate:** `bun run db:migrate`
- **DB push:** disabled by design. Generate a migration with `bun run db:generate`, then apply it with `bun run db:migrate`
- **DB studio:** `bun run db:studio`

## Architecture

Next.js 16 app using the App Router with React 19, React Compiler enabled, and Tailwind CSS v4.

**Path alias:** `@/*` maps to `./src/*`

### App Structure

The app is currently dashboard-first. Main routes live under `src/app/(protected)/`:
- The `(dashboard)` route group holds the dashboard home (`page.tsx`)
- Feature areas for `creatives`, `import`, `mer`, `accounts`, and `teams`
- `studio` for Image Studio: a brief-driven composer that queues image generation via a Trigger.dev job and streams realtime status, with a starter list of winning angles / high-purchase creatives derived from existing ad data
- Shared dashboard shell (sidebar, breadcrumbs, org guard) in `src/app/(protected)/layout.tsx`

### API

- tRPC route handler: `src/app/api/trpc/[trpc]/route.ts`
- tRPC setup: `src/lib/trpc/init.ts` and `src/lib/trpc/client.ts`
- App router composition: `src/lib/trpc/routers/_app.ts`
- Domain routers in `src/lib/trpc/routers/` for ads, ad sets, creatives, campaigns, insights, landing pages, tags, performance logs, AI helpers, and Image Studio (`studio`)
- File upload endpoint: `src/app/api/upload/route.ts`
- Background jobs live in `trigger/` (Trigger.dev); e.g. `generate-static-ads.ts` powers the `/studio` composer

### Database

PostgreSQL via Drizzle ORM with `node-postgres` driver. Connection uses `DATABASE_URL` env var.
- DB client: `src/db/index.ts`
- Schema files: `src/schema/*` (Drizzle config reads all files in this dir)
- Drizzle config: `drizzle.config.ts`

### UI

shadcn/ui (radix-nova style, olive base color) with Lucide icons. Components live in `src/components/ui/`.
