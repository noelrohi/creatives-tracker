# Klaviyo Production Bootstrap Wizard — Design

**Status:** Proposed for one-time rollout

**Date:** 2026-08-12

## Goal

Replace the manual Reviv production rollout checklist with one disposable local
wizard. The operator starts one command, reviews the probe and join rules once
in the existing Klaviyo Lab, and lets the wizard complete the initial 90-day
evidence pipeline. The wizard is deleted after rollout verification.

## Command and scope

Add `bun run klaviyo:bootstrap`, backed by
`scripts/klaviyo-bootstrap-wizard.ts`.

The wizard is deliberately bound to the single environment-configured Reviv
store. It accepts no organization, store, connection, credential, secret, or
date arguments. It derives the inclusive 90-store-day range from the bound
store timezone and uses existing repository/service entry points rather than
writing source, match, claim, or report rows directly.

## Environment handling

The wizard uses the authenticated Trigger CLI to pull the production
environment into a newly created temporary directory. It loads only the
required variables into the wizard process, never prints their values, and
removes the temporary directory on success, failure, signal, or cancellation.
The temporary path is outside the repository and is never committed.

Before mutation, the wizard verifies:

- the Trigger environment is `prod`;
- the database matches the configured production database;
- migrations through `0058_klaviyo_claims_reporting` are applied;
- exactly one configured Shopify store matches the Reviv shop domain;
- the expected Shopify, Klaviyo, identity-HMAC, and erasure-HMAC variables are
  present;
- no mismatched historical identity-key binding exists.

It prints safe identifiers, database counts, hostnames, stage names, and run
IDs only. It never prints URLs containing credentials, API keys, HMAC material,
identity digests, profile IDs, provider payloads, or raw error bodies.

## Workflow

The wizard runs stages sequentially and waits for each durable database graph,
not merely the first Trigger child:

1. Trigger `shopify-evidence-start` with `{ mode: "initial_90d" }`; require
   terminal `success + complete` or the existing policy-labelled acceptable
   partial state.
2. Prepare and trigger discovery; require terminal success and the expected
   Klaviyo account binding.
3. Prepare and trigger a 30-order probe; require a terminal pending review
   report.
4. Print the Klaviyo Lab URL and wait for the existing owner/admin UI to record
   the human decision. Continue only when the probe is passed, every candidate
   rule is reviewed, and at least one zero-collision deterministic rule is
   approved. A rejection ends the wizard without downstream work.
5. Prepare and trigger the initial 90-day order-core sync; require terminal
   success and exact order-core request parameters.
6. Trigger matching against the exact evidence and order-core runs; require an
   atomic published match run.
7. Start and finish the claim replay for that exact match publication.
8. Run the 90-day journey ingestion, dimensions ingestion, and 90-day campaign
   and flow reports sequentially. Dimensions must reach terminal success before
   reports start so report facts can resolve campaign linkage.
9. Print a final safe summary: evidence coverage, current match counts, claims,
   journey/dimension/report status, privacy-sweep counts, and Shopify monetary
   reconciliation equality.

The wizard never enables the daily schedule.

## Recovery and idempotency

Every stage reuses the existing service-level start-or-resume logic, persistent
run IDs, scoped locks, and Trigger global idempotency keys. Restarting the
wizard reads production state and resumes the first incomplete stage. It does
not create a second live run, approve a probe/rule, or replace a current
publication merely because the local process restarted.

An upstream failure stops the wizard and preserves prior source data and
publications. Interrupting the wizard does not cancel healthy Trigger children;
rerunning reconnects to their database graphs. The human review wait has no
automatic approval or timeout-to-approval behavior.

## Operator experience

The terminal shows one live checklist with the current stage, elapsed time,
safe progress counts, and the relevant Trigger run ID. During review it shows
one action only: open the Lab, approve or reject the probe, and review every
rule. The wizard then notices the database transition and continues without an
extra keypress.

## Verification

Tests cover preflight refusal, exact call order, terminal database waiting,
restart/resume, rejected review, unresolved candidate rules, zero-collision
approval, downstream failure isolation, dimensions-before-reports, cleanup of
the temporary environment file, and absence of secrets from output.

Before using production, run focused wizard tests, the relevant Klaviyo unit
tests, lint, build, and `git diff --check`. After the production run, compare
Shopify order count, Net sales, refunds, bucket/rule versions, Meta verification,
and production order timestamps against the pre-run snapshot.

## Cleanup

After production verification, remove the package script, wizard source, and
wizard-only tests in one cleanup commit. Keep the rollout record and safe final
summary in the existing manual gate checklist. No production task, API route,
schedule, schema, or database row exists solely to support the wizard.
