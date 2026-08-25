# UTM tracking filter and sort

## Goal

Make creatives with configured or missing UTM tracking easy to isolate from the Creatives table.

## Design

- Add an `All / Set / Missing` filter for UTM Tracking.
- Evaluate filter state with the same `getUtmParams` parser used by the table badge, so Meta URL tags and embedded landing-page UTMs behave identically everywhere.
- Filter the already-loaded creative rows client-side and preserve the selection in the page URL.
- Make the UTM Tracking column header toggle boolean sorting: missing-first, then set-first. Do not sort by parameter count.
- Keep the existing `Set · N` badge and full-value tooltip unchanged.
- UTM status applies to the selected ad represented by each creative row.

## Verification

Add focused parser/table behavior coverage where practical, then run lint, typecheck, unit tests, component tests, and build.
