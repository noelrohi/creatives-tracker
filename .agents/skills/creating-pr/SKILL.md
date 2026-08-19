---
name: creating-pr
description: Create pull requests the repo's way — a single PR, or an oversized change split into a linked GitHub stack. Use when asked to open a PR, split a branch or large diff into stacked PRs, or link existing PRs into a stack.
---

# Creating PRs (single or stacked)

The repo's own `CONTRIBUTING.md` and `.github/pull_request_template.md` are the source of truth for size limits, body format, and merge etiquette — read them before anything else. When the repo documents nothing, default to: one reviewable concern per PR, split past ~500 changed lines of hand-reviewable code.

## 1. Scope: one PR or a stack?

Measure the diff (`git diff <base>...HEAD --stat`) against the repo's size rule. Within the limit → single PR, skip to step 4. Past it → slice.

A **slice** is one PR's worth of change: a single concern, independently shippable, green on its own. Cut along the repo's preferred seams (commonly fix → data layer → UI → polish). Assign every changed file to exactly one slice; a file whose hunks span slices (routers, shared types) gets hand-built intermediate versions per slice.

## 2. Build the slice branches

1. **Scratch ref first**: commit the complete final state to a scratch branch. It is the safety net and the source you copy from — nothing is ever lost, and the final check compares against it.
2. Branch the bottom slice off the default branch; branch each later slice off the previous slice's branch.
3. On each branch: `git checkout <scratch-branch> -- <paths>` for files owned whole by the slice; hand-edit the split files to that slice's intermediate state.
4. Widened types ripple: when a lower slice adds required fields to shared shapes, patch downstream fixtures/tests minimally in that slice (neutral values, old assertions kept) so the slice is green without pulling in later UI.

## 3. Verify every slice

Each slice must be green standalone before its commit: typecheck, tests, lint — and build when routes or config change. Stale build artifacts (`.next/types` etc.) can produce phantom typecheck errors after switching branches; clear them rather than chasing ghosts.

Done when: every slice is green on its own, **and** the top slice's tree is byte-identical to the scratch ref (`git diff <scratch-branch>` is empty). An empty diff is the proof no hunk was dropped in the split.

## 4. Commit, push, open PRs bottom-up

- One commit per slice; follow the repo's commit conventions and trailer.
- Push all branches, then create PRs bottom-up: the bottom PR targets the default branch, each PR above targets the branch below it — `gh pr create --base <branch-below>`.
- Fill the repo's PR template for real: honest checklist (CI "pending" until it runs) and a stack note naming merge order and the base PR.
- Screenshots: you cannot upload images to GitHub — no attachments API exists, the web editor is the only path. For UI changes, leave the section as `TODO(@user): paste screenshots here` and tell the user the PR is waiting on them. Once they have pasted, re-read the body and rewrite the raw `user-attachments` URLs into a captioned before/after table (see #188 for the shape).
- Disclose judgment calls the diff makes silently (renames, scope adjacent to the ask) in the body — reviewers review intent.
- Repurposing an existing PR as one slice: force-push its branch, retarget and rewrite via REST (`gh api -X PATCH repos/{owner}/{repo}/pulls/{n} -f base=… -f title=… -f body=…`). Prefer REST here — `gh pr edit` currently trips a GraphQL projectCards deprecation and silently applies nothing.

## 5. Link the stack (native GitHub stacks)

Aligned bases alone already work — GitHub auto-retargets each PR to the default branch as its base merges — but linking them into a **native stack** (public preview since 2026-07) adds the stack UI, land-the-whole-stack merging, and auto-rebase of layers above. Replace the manual "preview stack" banner click with the API:

```bash
# ordered bottom → top; each PR's base must equal the previous PR's head
gh api -X POST repos/{owner}/{repo}/stacks \
  -F "pull_requests[]=176" -F "pull_requests[]=177" -F "pull_requests[]=178" -F "pull_requests[]=175"
```

Verify with `gh api repos/{owner}/{repo}/stacks` — the new stack lists the PRs in order. Other operations, same preview API:

| Operation | Call |
|---|---|
| List / get | `GET /repos/{o}/{r}/stacks`, `GET …/stacks/{stack_number}` |
| Add to top | `POST …/stacks/{stack_number}/add` with `pull_requests[]` |
| Dissolve | `POST …/stacks/{stack_number}/unstack` |

Preview caveats: same-repo branches only (no cross-fork), endpoints may change; on a 404, fall back to aligned bases — the PR pages then show GitHub's own banner offering to link the chain.

Greenfield alternative: when building a stack from scratch (not splitting an existing diff), the `gh stack` extension (`gh extension install github/gh-stack`) drives the whole flow — `gh stack init <branch>`, commit, `gh stack add <branch>`, `gh stack submit`.

## 6. Merge and report

Merge bottom-up (or land the whole stack at once from the top PR when everything is approved); each layer's merge auto-retargets or rebases the ones above. After the stack merges: sync the local default branch, delete the slice branches and the scratch ref, and confirm the tree matches origin.

Report to the user: PR numbers with their bases and sizes, the merge order, and anything left for a human (screenshots, CI still running).
