# API Keys Settings Page

## Goal

Build a web UI for organization-scoped API key management.

This is a frontend implementation spec. Backend support already exists.

---

## Route

`src/app/(protected)/settings/api-keys/page.tsx`

Also add a navigation entry from the user dropdown in:

`src/components/app-sidebar.tsx`

Place it near the existing "Invite members" link.

---

## Backend Contract

### tRPC router

Use the existing `apiKey` router:

`src/lib/trpc/routers/api-key.ts`

Available endpoints:

- `trpc.apiKey.list.query()`
- `trpc.apiKey.create.mutate({ name, scopes, expiresAt? })`
- `trpc.apiKey.revoke.mutate({ id })`
- `trpc.apiKey.delete.mutate({ id })`

### Response shapes

`apiKey.list` returns rows with:

- `id`
- `name`
- `prefix`
- `scopes`
- `lastUsedAt`
- `expiresAt`
- `revokedAt`
- `createdAt`
- `createdByUserId`

`apiKey.create` returns:

- all relevant metadata above
- `key`

Important: `key` is plaintext and only available at creation time. The UI must treat it as one-time reveal.

---

## Security Model

### Important constraint

API key management is **not** bearer-auth managed.

It requires:

- a signed-in browser session
- active organization selected
- org role of `owner` or `admin`

This is enforced in the backend. See:

- `src/lib/trpc/init.ts`
- `src/lib/trpc/routers/api-key.ts`

Do not design the page around machine auth.

### UX implication

Frontend should still provide a sensible unauthorized state:

- hide destructive controls for non-admins if role is known client-side
- or show a clear “Admins only” message

Backend is still the source of truth.

---

## Existing Patterns To Reuse

### Settings page pattern

Use this page as the structural reference:

`src/app/(protected)/settings/members/page.tsx`

### Sidebar / user dropdown pattern

Use this file:

`src/components/app-sidebar.tsx`

### tRPC hooks

Use the current app tRPC pattern:

`src/lib/trpc/client.ts`

### UI system

Use existing shadcn/ui primitives already in the repo.

Do not redesign the settings section visual language.

---

## Page Requirements

### Header

Top section should include:

- title: `API Keys`
- short description explaining that keys provide organization-scoped API access for automation and integrations

### Create key section

Include a create form with:

- `name` required
- `scopes` editable
- optional `expiresAt`

Implementation details:

- `scopes` can be a comma-separated text input or tag-style input
- default should be `*`
- `expiresAt` can be a datetime-local style input or another simple equivalent that serializes to ISO 8601 before mutation

### Post-create one-time reveal

After successful creation:

- show the plaintext key prominently
- provide a copy button
- include explicit warning text:
  - copy it now
  - it will not be shown again

Good options:

- dialog
- alert/callout block above the table

### Keys table

Render a list/table of existing keys with columns similar to:

- `name`
- `prefix`
- `scopes`
- `createdAt`
- `expiresAt`
- `lastUsedAt`
- `status`
- `actions`

### Status rules

Derive status from:

- `revokedAt` => `Revoked`
- expired `expiresAt` => `Expired`
- otherwise => `Active`

Use badges for status.

### Actions

Per row:

- revoke
- delete

Behavior:

- revoke should be idempotent from the UI perspective
- delete should confirm before proceeding

---

## Data / Role Handling

Follow the members page pattern:

- use `authClient.useActiveOrganization()`
- use `authClient.useSession()`

If you want role-aware UI gating, use:

- `authClient.organization.getFullOrganization({ query: { organizationId } })`

This is already used on the members page and can be reused to determine whether the current user is an `owner` or `admin`.

Recommended behavior:

- admins/owners: full management UI
- non-admins: read-only blocked state or explicit permission message

---

## Suggested File Shape

Preferred minimal implementation:

- `src/app/(protected)/settings/api-keys/page.tsx`

Optional extraction if needed:

- `src/app/(protected)/settings/api-keys/_components/create-api-key-form.tsx`
- `src/app/(protected)/settings/api-keys/_components/api-keys-table.tsx`
- `src/app/(protected)/settings/api-keys/_components/reveal-api-key-dialog.tsx`

Keep the first pass simple unless the page becomes too large.

---

## UX Notes

- show empty state when no keys exist
- make `lastUsedAt` and `expiresAt` human-readable
- highlight revoked / expired states clearly
- avoid showing anything that implies the raw secret can be recovered later

Copy should be precise:

- “Organization-scoped”
- “Use this key as `Authorization: Bearer <key>`”
- “Shown once”

---

## Out Of Scope

Do not build these in this pass:

- API key creation through bearer auth
- per-scope permission taxonomy redesign
- audit log UI
- usage analytics UI
- background rotation flows
- public developer onboarding flows

---

## Verification

Acceptance criteria:

1. `/settings/api-keys` loads in the app.
2. Admin user can create a key.
3. Newly created key is shown once and can be copied.
4. Refreshing the page does not reveal the plaintext key again.
5. Revoke updates the row state.
6. Delete removes the row.
7. Non-admin users get a clean blocked/read-only experience.
8. `bun run build` passes.

---

## Repo Context

Relevant backend/auth files:

- `src/schema/api-key.ts`
- `drizzle/0012_youthful_roulette.sql`
- `src/lib/api-keys.ts`
- `src/lib/trpc/init.ts`
- `src/lib/trpc/routers/api-key.ts`

Relevant docs/auth behavior:

- OpenAPI security is already configured in `src/lib/trpc/openapi.ts`
- normal org endpoints support bearer API key or session cookie
- API key management endpoints are session-cookie only
