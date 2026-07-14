---
name: pi-first
description: "Route implementation work to pi (gpt-5.6-sol) in a dedicated Herdr tab (max 4 panes, 2x2 grid; overflow opens another tab); Claude specs, reviews, verifies. Use for hands-on coding delegation when running inside Herdr (HERDR_ENV=1)."
---

# Pi First

Claude Code sessions only. pi/other harnesses: skip; never self-delegate.

Rationale: Claude (Fable/Opus) tokens metered + expensive; pi runs gpt-5.6-sol flat-rate via the codex provider. GPT-5.6 is usually better and faster at writing/implementing code; Claude wins at ergonomics — judgment, design, spec-writing, review, orchestration. So pi types, Claude thinks and verifies.

## Route

Delegate to pi (default for hands-on work):

- implementation from a frozen spec; refactors; mechanical migrations
- bug fixes with known repro; test writing; coverage fills
- CI fixes, dependency bumps, scripts/tooling
- bulk codebase exploration where raw reading ≫ the answer

Keep in Claude:

- design, API design, architecture, naming, UX judgment
- tasks where writing the spec IS the work (ambiguity = design)
- tiny edits (~<20 lines, single obvious change) — delegation overhead loses
- anything needing session tools: MCP (browser/computer-use), 1Password, secrets
- destructive/irreversible ops, releases, pushes, GitHub mutations — Claude-side per git rules
- review of pi output — never delegated, never skipped

Mixed task: Claude designs first, freezes spec, delegates build-out.
Heuristic: prompt reads as a work order → delegate; writing it forces decisions → design, Claude.
UI work is always mixed: Claude picks the UX pattern from the code and the user's description, freezes a spec naming exact components/files and the shadcn/icon conventions, then delegates the build. No browser inspection unless the user asks for it — the user handles visual inspection/verification; Claude verifies the diff.

## Invoke (Herdr pane)

Requires a Herdr-managed pane:

```bash
test "${HERDR_ENV:-}" = 1
```

If the check fails, fall back to non-interactive pi in a plain background Bash:

```bash
P=$(mktemp); cat >"$P" <<'EOF'
<goal, repo + key paths, constraints ("don't touch X"), non-goals, proof expected, output shape>
EOF
pi --print --model openai-codex/gpt-5.6-sol --thinking high "$(cat "$P")"
```

Inside Herdr, run pi interactively in a dedicated tab — never split the calling tab. Each delegation batch gets its own background tab in the current workspace, holding at most 4 panes in a 2×2 grid (2 columns, 2 rows). Task 5+ → create another tab in the same workspace and start a new grid.

1. Write each spec to a temp file (never inline-quote long prompts):

```bash
P=$(mktemp -t pi-spec); cat >"$P" <<'EOF'
<goal, repo + key paths, constraints, non-goals, proof expected, output shape>
EOF
```

2. Create the tab in the current workspace, keep the user's focus, parse IDs from JSON — never construct them. `result.root_pane.pane_id` is the first grid slot (top-left), `result.tab.tab_id` is the tab:

```bash
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --label "pi" --no-focus
```

Build only as many grid slots as there are tasks, splitting from the root pane `A`:

```bash
herdr pane split --pane <A> --direction right --no-focus   # → B (top-right)
herdr pane split --pane <A> --direction down  --no-focus   # → C (bottom-left)
herdr pane split --pane <B> --direction down  --no-focus   # → D (bottom-right)
```

1 task → root pane only; 2 → A+B; 3 → A+B+C; 4 → full grid. Never add a 5th pane to a tab — open a new tab instead.

Then per slot, label it and launch pi:

```bash
herdr pane rename <pane-id> "pi: <short task name>"
herdr pane run <pane-id> "pi --model openai-codex/gpt-5.6-sol --thinking high"
```

3. Wait for pi's prompt, then submit the task pointing at the spec file:

```bash
herdr wait agent-status <returned-pane-id> --status idle --timeout 30000
herdr pane run <returned-pane-id> "Read $P and implement it exactly. Report files changed + proof output when done."
```

4. Wait for completion, then read the transcript:

```bash
herdr wait agent-status <returned-pane-id> --status working --timeout 30000
herdr wait agent-status <returned-pane-id> --status done --timeout 1800000
herdr pane read <returned-pane-id> --source recent-unwrapped --lines 150
```

- Model default: `openai-codex/gpt-5.6-sol`, thinking `high` — pin both explicitly; don't rely on user config.
- Background pane completions report `done`; if the user is watching the tab it reports `idle` — treat either as completed.
- Wait timeout exits `1`: inspect `herdr pane get` + `pane read` before deciding. `blocked` = pi is asking something — answer it with `pane run`.
- Don't kill quiet runs <30 min.
- Parallel independent tasks OK: one grid slot each, separate repos/dirs, separate spec files. Kick off all slots, then wait on each.
- Follow-up fixes: same pane, just `herdr pane run <pane-id> "<fix instruction>"` — cheaper than fresh runs, keeps pi's session context.
- Cleanup: close only tabs/panes you created (`herdr tab close <tab-id>`), and only after verification passes. Leave the tab open if the user may want to inspect the runs.

## Prompt contract

pi starts with zero session context (it reads AGENTS.md/CLAUDE.md, nothing else). Every spec: goal, exact repo/paths, constraints, non-goals, proof expected (exact test command), output shape ("report files changed + test output"). Spec quality decides success.

## Verify (Claude, always)

- `git status -sb` + read the full diff; judge like a contributor PR
- run focused tests yourself or demand proof output; pi claims are advisory
- iterate via `pane run` follow-ups; after 2 failed rounds, take over and do it directly

## Economics

Win = generation + exploration tokens moved to pi; Claude spends only on spec + diff review. Don't ping-pong trivia through delegation; don't re-read what pi already summarized.
