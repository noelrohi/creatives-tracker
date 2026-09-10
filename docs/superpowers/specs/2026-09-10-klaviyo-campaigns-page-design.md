# Klaviyo Campaigns Page — Design

**Date:** 2026-09-10
**Status:** Approved
**Branch:** `feat/klaviyo-campaigns-page` (off `main`)

## 1. Goal

Put the Klaviyo campaign ledger front and center, the way the Meta dashboard
is: a first-class page every org role can open from the sidebar, showing the
ranked campaign/flow ledger and its detail sheet. The rest of the Klaviyo Lab
(orders, unmatched events, probe, list health) stays admin-only at its current
URL, and the pilot's single-tenant binding is unchanged.

### Decisions taken during brainstorming

| Question | Decision |
| --- | --- |
| Placement | New page at `/klaviyo`; sidebar "Klaviyo" for all roles under Dashboard, after Meta; the lab keeps `/attribution/klaviyo` and leaves the sidebar, reachable via an admin-only "Open lab" link |
| Member access | Everything read-only: table, message rows, full detail sheet. Only Refresh report and "View orders" are admin-only |
| Tenant scope | Unchanged: the env-bound Reviv connection; other orgs see an empty state with no call to action |
| Lab's Campaigns tab | Kept, backed by the same shared component |

## 2. Non-goals

- Per-org Klaviyo credentials or a connect flow (the "self-serve connect"
  follow-up).
- Any change to the lab's other views, the attribution panel, or the ledger's
  loaders and row rules.
- Opening any other `klaviyo.*` procedure to members.

## 3. Routing and navigation

- New route `src/app/(protected)/klaviyo/page.tsx` renders the page for any
  org role. No access gate component wraps it.
- `src/components/app-sidebar.tsx`: the Dashboard children gain
  `{ label: "Klaviyo", href: "/klaviyo" }` (not privileged) placed directly
  after Meta; the privileged `/attribution/klaviyo` entry is removed. The lab's
  route, its deep links from the attribution panel (`view=list-health`), and
  its bookmarks keep working unchanged.
- The page header carries an "Open lab" link to `/attribution/klaviyo` that
  renders only for privileged roles (`isPrivilegedOrgRole`).

## 4. Page shape

Header: title "Klaviyo campaigns"; the account name; "matches published … ago"
freshness from `lastMatchPublishedAt` like the attribution panel; for
privileged roles, the Refresh report button and the Open lab link.

Body: the ledger's filter row (date range with the calendar picker for
Custom, kind, channel, search), the ledger table with lazily mounted message
rows, and the half-width detail sheet — all the existing components under
`src/components/blocks/attribution/klaviyo/ledger/`, unchanged.

Not configured (no pilot connection for this org): the Meta-style centered
empty state — "No Klaviyo connection for this organization" with the line
"The Klaviyo pilot is bound to one store; ask an admin if you expected data
here." No button.

## 5. Components and state

New folder `src/components/blocks/klaviyo/`:

- `klaviyo-campaigns-page.tsx` — the page component: queries
  `klaviyo.ledgerContext`, resolves the day range from `todayInAccountTz`,
  owns expansion state, and renders header, filters, `LedgerTable`,
  `LedgerMessageRows`, and `LedgerDetailSheet`.
- `use-ledger-page-state.ts` — nuqs URL state with only the ledger's params:
  `range`, `from`, `to`, `ledgerKind`, `ledgerChannel`, `q`, `source`,
  `sort`, `dir`, and the same `openSource` / `closeSource` / `toggleSort` /
  `clearFilters` helpers the lab hook exposes. Parsers are shared constants
  exported from one module (`ledger-url-state.ts`) so the lab's hook and the
  page's hook cannot diverge on the shared params.
- `ledger-filters.tsx` — the ledger's filter row extracted from the lab's
  `LabFilterBar` (range select + calendar picker, kind, channel, search). The
  lab's filter bar renders this component for its ledger view.
- `campaigns-page.copy.ts` — the page's strings.

Shared ledger wiring: the playground's `LedgerView` becomes a thin adapter
that renders the same `LedgerSection` (table + message rows) from the new
folder, passing its lab state; the page passes its page state. The detail
sheet's "View orders" becomes an optional `onViewOrders` prop: the lab passes
its `viewOrdersForSource`; the page passes, for privileged roles only, a
navigation to `/attribution/klaviyo?view=orders&source=<id>&range=custom&from=<day>&to=<day>`
(campaign send day to today, or the page's range for flows), and nothing for
members, so the link does not render.

`LedgerDetailSheet` takes `{ objectId, range, onClose, onViewOrders? }`
instead of the lab hook, so both callers can drive it.

## 6. API and roles

- `klaviyo.ledger.list`, `.messages`, `.detail` move from `orgAdminProcedure`
  to `orgProcedure`. Scope, inputs, outputs, and the NOT_FOUND mapping are
  unchanged.
- New `klaviyo.ledgerContext` on `orgProcedure`, no input, returns:
  `{ configured: boolean; accountName: string | null; accountTimezone: string;
  todayInAccountTz: string; lastMatchPublishedAt: Date | null;
  lastReportSyncedAt: Date | null }`. When the org has no pilot connection it
  returns `configured: false` with nulls and UTC defaults instead of throwing.
- `refreshReports` and every other `klaviyo.*` procedure stay
  `orgAdminProcedure`.
- Router tests: a second RBAC table for the four org-readable procedures
  asserting member sessions pass and API-key and worker callers are still
  forbidden; the existing admin-only table loses the three ledger entries.

## 7. States and errors

- Context loading: header and table skeletons.
- `configured: false`: the empty state of §4; no ledger query is issued.
- Ledger query error: the table's existing error row with Retry.
- No report for the range: the existing "No report for this range yet" line;
  the Refresh button beside it renders only for privileged roles, members see
  "Ask an admin to refresh the report."
- Sheet, message rows, and search keep their existing states.

## 8. Testing

- Router: role change on the three ledger procedures; `ledgerContext` shape
  for configured and not-configured orgs; RBAC tables as in §6.
- Component: `klaviyo-campaigns-page.component.test.tsx` covering the empty
  state, the admin header (Refresh + Open lab present), and the member header
  (neither present, sheet still opens), using the tRPC mock pattern of
  `email-revenue-panel.component.test.tsx`.
- Unit: `ledger-url-state.test.ts` pins the shared parser keys and defaults;
  the lab-state test asserts the lab hook still exposes them.
- Existing ledger component tests continue to cover table and sheet.

## 9. Rollout

No schema or job changes. Deploys with the next merge; the lab's sidebar entry
disappears and the new one appears for everyone.
