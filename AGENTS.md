# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Commands

- **Dev server:** `bun dev` (Next.js dev server on port 3000)
- **Build:** `bun run build`
- **Start:** `bun run start`
- **Lint:** `bun run lint` (ESLint)
- **DB generate:** `bun run db:generate`
- **DB migrate:** `bun run db:migrate`
- **DB push:** `bun run db:push`
- **DB studio:** `bun run db:studio`

## Architecture

Next.js 16 app using the App Router with React 19, React Compiler enabled, and Tailwind CSS v4.

**Path alias:** `@/*` maps to `./src/*`

### App Structure

The app is currently dashboard-first. Main routes live under `src/app/(dashboard)/`:
- `page.tsx` for the dashboard home
- Feature areas for `briefs`, `compare`, `creatives`, `import`, `insights`, and `landing-pages`
- Shared dashboard shell in `src/app/(dashboard)/layout.tsx`

### API

- tRPC route handler: `src/app/api/trpc/[trpc]/route.ts`
- tRPC setup: `src/lib/trpc/init.ts` and `src/lib/trpc/client.ts`
- App router composition: `src/lib/trpc/routers/_app.ts`
- Domain routers in `src/lib/trpc/routers/` for ads, ad sets, creatives, campaigns, insights, landing pages, tags, performance logs, and AI helpers
- File upload endpoint: `src/app/api/upload/route.ts`

### Database

PostgreSQL via Drizzle ORM with `node-postgres` driver. Connection uses `DATABASE_URL` env var.
- DB client: `src/db/index.ts`
- Schema files: `src/schema/*` (Drizzle config reads all files in this dir)
- Drizzle config: `drizzle.config.ts`

### UI

shadcn/ui (radix-nova style, olive base color) with Lucide icons. Components live in `src/components/ui/`.
