# Competitor ad status filtering and reset

## Goal

Make triage reversible and keep the default competitor ad grid focused on ads that have not been triaged.

## Behaviour

### All ads

- Keep **All ads** as the default tab.
- By default, show only ads whose workflow status is `inbox`.
- Add a status filter beside the existing format, theme, and sort controls.
- Status filter options are **Untriaged**, **Shortlisted**, **Deprioritised**, **Made ad**, and **All statuses**.
- The default filter value is **Untriaged**.
- The format, theme, status, and sort filters combine, remain URL-backed, and survive reloads and shared links.
- The All ads tab count remains the total number of active ads. The result count reflects the currently visible ads.
- When All statuses is selected, triaged cards retain their existing stage labels.

### Workflow tabs

- Shortlist, Deprioritised, and Made ad continue to show only their respective statuses.
- Ads are selectable in every workflow tab.
- Each workflow tab provides a **Move to All ads** bulk action. This sets selected ads back to `inbox`.
- Shortlist retains **Make ad** and **Deprioritise** actions.
- Deprioritised and Made ad need no additional forward action in this change.
- Selection remains scoped to the active tab and visible filtered results.

## Data flow

The existing `setAdWorkflowStatus` mutation already accepts `inbox`, so no schema or migration change is required. The grid submits selected ad IDs with `status: "inbox"` for **Move to All ads**, then clears selection and invalidates the competitor ads query using the existing mutation lifecycle.

All filtering remains client-side because the competitor ads query already returns the complete active-ad set. A URL status-filter value is separate from the workflow-tab query parameter so tab navigation and All ads filtering do not conflict.

## Empty states

- All ads with the default Untriaged filter and no matching ads says there are no untriaged ads.
- Any explicitly filtered view with no matches says **No ads match these filters**.
- Existing workflow-tab empty states remain unchanged.

## Testing

Component tests cover:

- All ads hides shortlist, deprioritised, and made ads by default.
- Each status option and All statuses reveals the expected ads.
- Status filtering composes with format and theme filters.
- All statuses shows stage labels for triaged ads.
- Each workflow tab can move selected ads to `inbox`.
- Selection and empty-state behaviour remain correct after filtering.

Router tests do not need new mutation behaviour coverage because `inbox` is already an accepted and tested workflow status; implementation should confirm that existing coverage includes this value.

## Out of scope

- New workflow statuses or database changes.
- Server-side pagination or filtering.
- Changing how active ads are ingested or expired.
