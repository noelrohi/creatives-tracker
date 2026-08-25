# Member Meta Access

## Problem

Organization members can see the Meta navigation item, but opening `/meta` redirects them to `/`. The centralized member route allowlist omits the Meta route even though the page already treats members as read-only.

## Design

Add `/meta` to `MEMBER_PATH_PREFIXES` in `src/lib/organization-access.ts`. This keeps route authorization centralized and allows both `/meta` and any nested Meta routes while preserving the existing boundary-safe prefix matching.

The Meta page's existing role checks remain unchanged: members may read performance data and export it, but import controls and data-management freshness actions stay hidden.

## Testing

Extend the member path access test to assert that `/meta` is a permitted base read-only surface. Existing path-boundary and privileged-route tests continue to guard against accidental access expansion.
