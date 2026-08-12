# AGENTS.md

## Commands

- **Dev server:** `bun dev` (port 3000)
- **Build:** `bun run build`
- **Lint:** `bun run lint` (ESLint)
- **Test:** `bun run test` (Vitest; `bun run test:watch` for watch mode). Not `bun test` — that invokes Bun's own runner and ignores `vitest.config.ts`
- **Component tests:** `bun run test:components` (Vitest with `vitest.components.config.ts`)
- **DB generate:** `bun run db:generate`
- **DB migrate:** `bun run db:migrate`
- **DB push:** disabled by design. Generate a migration with `bun run db:generate`, then apply it with `bun run db:migrate`
- **DB studio:** `bun run db:studio`
- **Trigger.dev:** `bun run trigger:dev` (local), `bun run trigger:deploy`

## Architecture

Next.js 16 app using the App Router with React 19, React Compiler enabled, and Tailwind CSS v4.

**Path alias:** `@/*` maps to `./src/*`

### App Structure

Main routes live under `src/app/(protected)/`:
- The `(dashboard)` route group holds the dashboard home (`page.tsx`)
- Feature areas for `creatives`, `campaigns` (manager view: campaign → ad set → ad ledger), `import`, `mer`, `accounts`, `attribution` (including the Klaviyo Lab pilot UI), `teams`, and `settings` (API keys, members, org)
- `studio` for Image Studio: a brief-driven composer that queues image generation via a Trigger.dev job and streams realtime status
- Shared dashboard shell (sidebar, breadcrumbs, org guard) in `src/app/(protected)/layout.tsx`

### API

- tRPC route handler: `src/app/api/trpc/[trpc]/route.ts`
- tRPC setup: `src/lib/trpc/init.ts` and `src/lib/trpc/client.ts`
- App router composition: `src/lib/trpc/routers/_app.ts`
- Domain routers in `src/lib/trpc/routers/`, one file per domain, composed in `_app.ts` (Image Studio is split across `studio.*.ts`)
- OpenAPI reference: `src/app/api/openapi/`
- File upload endpoint: `src/app/api/upload/route.ts`
- Background jobs live in `trigger/` (Trigger.dev): Meta/Shopify sync (`meta-sync.ts`, `shopify-sync.ts`, `shopify-evidence-sync.ts`), Studio image generation (`generate-static-ads.ts`, `generate-studio-suggestions.ts`), landing-page enrichment (`harvest-landing-pages.ts`, `classify-landing-pages.ts`, `enrich-creative-tags.ts`), attribution checks (`attribution-checks.ts`), and the Klaviyo pilot chain (`klaviyo-*.ts`)

### Auth

Better Auth with the organization plugin (orgs + members only). Teams and API keys are app-owned, not Better Auth plugins: `src/schema/team.ts` + `src/lib/trpc/routers/team.ts`, and `src/schema/api-key.ts` + `src/lib/api-keys.ts` (sha256-hashed `ask_`-prefixed keys).
- Server config: `src/lib/auth.ts`; client: `src/lib/auth-client.ts` and `src/lib/organization-client.ts`
- Route handler: `src/app/api/auth/[...all]`
- Org access helpers: `src/lib/organization-access.ts`

### Database

PostgreSQL via Drizzle ORM with `node-postgres` driver. Connection uses `DATABASE_URL` env var.
- DB client: `src/db/index.ts`
- Schema files: `src/schema/*` (Drizzle config reads all files in this dir)
- Drizzle config: `drizzle.config.ts` (`drizzle-prod.config.ts` for prod)

### UI

shadcn/ui components live in `src/components/ui/` (config in `components.json`).

Icons: Solar (linear) via `@iconify/react`, re-exported under Lucide-style names from `src/components/icons.tsx`. Import from `@/components/icons` — `lucide-react` is not installed and is blocked by lint. `components.json` still says `lucide` (the shadcn CLI has no iconify option), so rewrite imports on freshly generated components.
