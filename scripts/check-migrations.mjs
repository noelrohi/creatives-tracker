#!/usr/bin/env node
// CI guard for Drizzle migrations. Fails the PR when the migration history
// diverges from the base branch instead of extending it — the situation that
// otherwise surfaces as broken `db:migrate` runs after merge.
//
// Checks, against BASE_REF (default origin/main):
//   1. The base journal's entries are an exact prefix of this branch's journal.
//   2. New entries continue the idx sequence with no gaps.
//   3. Every new entry has its .sql file and meta snapshot.
//   4. No orphan .sql files that aren't in the journal.
//
// If this fails, don't rename files by hand — follow "Resolving migration
// conflicts" in CLAUDE.md (drop your migration, rebase, re-generate).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const BASE_REF = process.env.BASE_REF ?? "origin/main";
const JOURNAL_PATH = "drizzle/meta/_journal.json";

function fail(message) {
  console.error(`\nMigration check failed:\n\n${message}\n`);
  console.error(
    'Fix: follow "Resolving migration conflicts" in CLAUDE.md — delete your branch\'s migration, rebase onto main, and re-run `bun run db:generate`. Do not renumber files by hand.',
  );
  process.exit(1);
}

let baseJournalRaw;
try {
  baseJournalRaw = execFileSync("git", ["show", `${BASE_REF}:${JOURNAL_PATH}`], {
    encoding: "utf8",
  });
} catch {
  console.log(`No journal found at ${BASE_REF}; skipping migration check.`);
  process.exit(0);
}

const baseEntries = JSON.parse(baseJournalRaw).entries;
const headEntries = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")).entries;

// 1. Base history must be an untouched prefix of head history.
if (headEntries.length < baseEntries.length) {
  fail(
    `This branch's journal has fewer entries (${headEntries.length}) than ${BASE_REF} (${baseEntries.length}). Migrations that already exist on main must not be deleted.`,
  );
}
for (let i = 0; i < baseEntries.length; i++) {
  const base = baseEntries[i];
  const head = headEntries[i];
  if (base.idx !== head.idx || base.tag !== head.tag) {
    fail(
      `Journal entry ${i} differs from ${BASE_REF}: expected idx ${base.idx} "${base.tag}", found idx ${head.idx} "${head.tag}". Existing migrations must not be renamed or reordered.`,
    );
  }
}

// 2. New entries continue the sequence without gaps.
const newEntries = headEntries.slice(baseEntries.length);
let expectedIdx = baseEntries.length > 0 ? baseEntries.at(-1).idx + 1 : 0;
for (const entry of newEntries) {
  if (entry.idx !== expectedIdx) {
    fail(
      `New journal entry "${entry.tag}" has idx ${entry.idx}, expected ${expectedIdx}. The sequence must continue from ${BASE_REF}'s latest migration.`,
    );
  }
  expectedIdx++;
}

// 3. Every new entry has its .sql file and meta snapshot.
for (const entry of newEntries) {
  const sqlPath = `drizzle/${entry.tag}.sql`;
  const snapshotPath = `drizzle/meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`;
  if (!existsSync(sqlPath)) {
    fail(`Journal entry "${entry.tag}" has no matching ${sqlPath}.`);
  }
  if (!existsSync(snapshotPath)) {
    fail(
      `Journal entry "${entry.tag}" has no matching ${snapshotPath}. Generate migrations with \`bun run db:generate\`, never by hand.`,
    );
  }
}

// 4. No orphan .sql files outside the journal.
const journalTags = new Set(headEntries.map((entry) => entry.tag));
const orphans = readdirSync("drizzle")
  .filter((name) => name.endsWith(".sql"))
  .map((name) => name.replace(/\.sql$/, ""))
  .filter((tag) => !journalTags.has(tag));
if (orphans.length > 0) {
  fail(
    `Found .sql files not registered in ${JOURNAL_PATH}: ${orphans.join(", ")}. drizzle-kit will never apply these.`,
  );
}

console.log(
  newEntries.length > 0
    ? `Migration check passed: ${newEntries.length} new migration(s) cleanly extend ${BASE_REF} (${newEntries.map((entry) => entry.tag).join(", ")}).`
    : `Migration check passed: no new migrations relative to ${BASE_REF}.`,
);
