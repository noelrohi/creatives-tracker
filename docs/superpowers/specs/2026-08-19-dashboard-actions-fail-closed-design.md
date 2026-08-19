# Dashboard Actions Fail-Closed Design

## Goal

Prevent unresolved organization roles and member roles from receiving enabled attribution finding actions on both the main dashboard and the legacy insights dashboard.

## Design

Both pages will derive `canAct` with the existing `isPrivilegedOrgRole(role)` capability helper. The helper returns `true` only for resolved `owner` and `admin` roles, so the UI remains read-only while the role is loading and for members. Server-side authorization remains the final enforcement layer.

The change is limited to:

- `src/app/(protected)/(dashboard)/page.tsx`
- `src/app/(protected)/insights/page.tsx`

No role-hook behavior, route access, or server authorization will change.

## Verification

Add regression coverage for the fail-closed role capability, then verify the affected code with the focused test, ESLint, and TypeScript validation.
