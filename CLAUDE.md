# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Dev server:** `bun dev` (Next.js dev server on port 3000)
- **Build:** `bun run build`
- **Lint:** `bun run lint` (ESLint)
- **DB migrations:** `bunx drizzle-kit generate` / `bunx drizzle-kit migrate` / `bunx drizzle-kit push`

## Architecture

Next.js 16 app using the App Router with React 19, React Compiler enabled, and Tailwind CSS v4.

**Path alias:** `@/*` maps to `./src/*`

### Auth

Authentication via Better Auth with email/password, organization, and admin plugins:
- Server config: `src/lib/auth.ts` — exports `auth` instance and `Session` type
- Client hooks: `src/lib/auth-client.ts` — exports `signIn`, `signUp`, `signOut`, `useSession`, `organization`, `admin`
- API route: `src/app/api/auth/[...all]/route.ts`
- Auth pages under `src/app/(auth)/` route group (sign-in, sign-up)

### Database

PostgreSQL via Drizzle ORM with `node-postgres` driver. Connection uses `DATABASE_URL` env var.
- DB client: `src/db/index.ts`
- Schema files: `src/schema/*` (Drizzle config reads all files in this dir)
- Drizzle config: `drizzle.config.ts`

### UI

shadcn/ui (radix-nova style, olive base color) with Lucide icons. Components live in `src/components/ui/`.
