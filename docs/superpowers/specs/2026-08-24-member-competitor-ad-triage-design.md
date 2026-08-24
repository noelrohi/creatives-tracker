# Member competitor ad triage

## Goal

Allow every organization role—owner, admin, and member—to move competitor ads through the existing triage workflow without broadening permissions for unrelated data changes.

## Design

Add a reusable organization-member write procedure alongside the existing admin-gated write procedure. It will:

- require an active organization for sessions and MCP users;
- allow every valid organization role;
- preserve write-scope enforcement for API keys;
- preserve worker access;
- reject principals without organization membership or supported machine authentication.

Use this procedure only for `signals.setAdWorkflowStatus`. All other mutations using `orgWriteProcedure`, `orgAdminProcedure`, or `orgOwnerProcedure` retain their current restrictions. The mutation continues to scope updates by `organizationId`, so callers cannot move another organization's ads.

No UI changes are required: all roles already see the selection controls and actions, and mutation errors already surface as toasts.

## Testing

Add authorization coverage proving:

- a member can call `setAdWorkflowStatus`;
- the mutation remains organization-scoped;
- existing member restrictions on unrelated write procedures remain unchanged;
- read-only API keys cannot use the new member-write procedure.

## Out of scope

- Allowing members to add, archive, or otherwise manage competitors.
- Relaxing permissions for any other data mutation.
- Changing workflow statuses, labels, or UI behavior.
