# Shopify evidence: trim the per-order commit (phase 1)

## Problem

`shopify-evidence-batch` is now this project's largest Trigger cost (~$1.90 per 30 days). A batch of 25 orders takes ~135s, about 5.4s per order. The Trigger worker runs in us-east-1 and the Neon database in ap-southeast-1, so each DB round-trip costs ~200ms. Per order:

- Shopify calls (lines, then identity): ~0.4–0.8s.
- `commitShopifyEvidenceOrder`: one transaction of ~22 sequential round-trips, ~4.4s.

Prod (14 days): most re-fetched orders are unchanged. The daily "changed" run re-fetches ~500–650 orders because `order_updated_at` moved, but only 0–2 a day have different evidence content. Much of the commit's work is redundant on every order, changed or not.

## Scope

**Phase 1 (this spec):** remove redundant round-trips from the existing per-order commit. The structure stays the same: one transaction per order, the same locks in the same order, the same invariants. It applies to every order: unchanged, changed, new, and Sunday full runs.

**Phase 2 (deferred, decided after measuring phase 1):** a batched commit path for orders whose content is unchanged. It is not designed here. If pursued, it must reuse phase 1's shared checks (store lock, suppression check, policy validation) rather than copy them.

**Out of scope:**
- **The "available identity, no email" re-fetch.** An order with identity `available` but no email has no HMAC, so no identity link. The "changed" filter then re-fetches it every night. Prod has exactly 1 such order, so this is accepted as a known gap.
- **The two full runs on 2026-10-02.** Two full refreshes ran on the same day instead of one; to be investigated separately.

## Design

Each change below is inside `commitShopifyEvidenceOrder` and its helpers in `src/lib/shopify-evidence-store.ts`.

### 1. Key policy: one read-only check per order

**Today:** `ensureIdentityCryptoPolicyWithExecutor` runs on every order, under the store lock. That is about 5 round-trips: insert the key binding if missing, read it back, insert the policy if missing, then the validate step's two reads.

**After:** per order, a single read-only query loads the key binding and the policy, and validates them with today's rules. It runs after the store lock.
- The full ensure (create if missing, then validate) still runs once per batch, where it does today (`runShopifyEvidenceBatch` → `ensureCryptoPolicy`).
- A mismatch fails the commit with `identity_crypto_policy_conflict`, as today.
- If the binding or policy row is **missing** (a store's very first identity write), the commit falls back to today's full ensure. That keeps today's behaviour, where the commit's own ensure creates them.
- The existing `validateExistingIdentityCryptoPolicyWithExecutor` is rewritten onto the same single read, so the rules live in one place.

**Why it is safe:** every writer of the key policy holds the same `shopify_store` row lock that the commit takes first. That covers the identity rotation functions (`prepareIdentityRotation`, `runIdentityRotationBatch`, `pruneIdentityRotation`, `abortIdentityRotation`, all via `withKlaviyoStoreConnectionLock`). A read taken after the store lock therefore cannot observe a rotation halfway through.

Saves ~4 round-trips.

### 2. Lines: rewrite only when they differ

**Today:** `replaceCompleteLineSetWithExecutor` deletes and re-inserts every line on every commit. `loadMatcherVisibleLines` then re-reads them to compute the checksum.

**After:** read the stored lines once and compare them with the fetched complete set.
- **Same:** the two sets are identical by line-item id in every column a reader uses: `shopify_line_item_id`, `shopify_product_id`, `shopify_variant_id`, `sku`, `product_title`, `variant_title`, `quantity` and `source_position`. In that case, skip the delete and insert.
- **Otherwise:** replace the lines exactly as today.
- **`parent_order_updated_at`:** not compared and not refreshed on a skip. Nothing reads it, and the rewrite is its only writer. On a skipped order it keeps the order timestamp from when the lines were captured. That stays true, because the lines were captured then and have not changed.
- **Checksum:** computed from the in-memory line set that is now stored, without re-reading.
- **Partial line sets** (`preserved_partial`) keep today's path unchanged.
- **Matcher guard:** the Klaviyo match recomputes checksums from the stored lines (`loadShopifyProjection`, `shopify_content_mutated`), so a mismatch would still be caught there.

Saves 2 round-trips when the lines are the same. When they differ, the read plus the rewrite costs the same as today's rewrite plus re-read, so there is no saving.

### 3. `shopify_customer_id`: write only when it differs

**Today:** every available-identity commit runs `UPDATE shopify_order SET shopify_customer_id = …`.

**After:** `resolveScopedOrder` already selects the order `FOR UPDATE` at the start of the transaction. It also reads `shopify_customer_id`, and the update runs only when the value differs. Suppression still clears identity exactly as today.

Saves 1 round-trip.

### 4. Projection: reuse the locked order row

**Today:** the order is selected a second time for the projection.

**After:** that read reuses the columns of the row from `resolveScopedOrder`, which is selected `FOR UPDATE`, so the row cannot have changed within the transaction.

Saves 1 round-trip.

### 5. Observation and identity link: insert first

**Today:** each of the two writes selects for update, then inserts.

**After:** each runs `INSERT … ON CONFLICT DO NOTHING RETURNING`.
- If a row is returned, the write happened.
- On conflict (a replay of an already-committed order, which is rare), select the existing row and apply today's replay comparison and errors exactly.
- The unique keys `shopify_evidence_observation_scope_run_order_uniq` and `shopify_evidence_identity_observation_run_order_uniq` make this safe.

Saves ~2 round-trips.

### Unchanged

- Store lock, run lock and order lock, and their order.
- The run's cursor compare-and-set, and the count and state checks.
- The window check.
- `assertAvailableIdentityEvidence`.
- The suppression check, and clearing identity on a hit.
- Identity HMAC: the select for update, compare, and rewrite or delete.
- The run progress update.
- The batch-level and finish-time logic: carry-forward, snapshot assertions and the refresh plan.

### Expected effect

About 22 round-trips per order down to about 13, so ~5.4s to ~3.6s per order: **~−35% for this task**. Sunday full runs and new orders get the same trims.

## Testing

Postgres integration tests in `src/lib/shopify-evidence.integration.test.ts`:

1. **Same lines.** Committing an order whose fetched lines equal the stored lines leaves the line rows untouched (same row ids). The observation checksum equals a fresh recomputation from the stored lines, the same check the matcher makes.
2. **Different lines.** A changed `product_title`, `quantity`, or an added or removed line rewrites the lines, and the checksum follows.
3. **`shopify_customer_id`.** Not written when unchanged; written when changed. Detection uses the row's `xmin`, which every update changes. That holds even for raw-SQL updates that leave `updated_at` alone. The test compares `xmin` before and after a commit in which nothing else updates that `shopify_order` row.
4. **Replays.** Re-committing an already-committed order in the same run still hits the conflict branch and enforces today's replay checks for both the observation and the identity link, including the conflict errors.
5. **Key policy.**
   - A stored policy that no longer validates when the commit runs (for example a rotated key version) fails the commit with `identity_crypto_policy_conflict`.
   - An existing, valid policy is checked with a single read and no writes.
   - Missing rows (a store's first identity write) still run today's full ensure, which creates them. That is today's behaviour, unchanged.
6. **Suppression.** A suppression added after the batch started still clears identity on commit.
7. **Regression.** The existing evidence, reconciliation and Klaviyo match suites stay green.

## Rollout and verification

No schema change, no migration. Deploys through `main` (CI `trigger-deploy`).

Verification after the next daily run:
- `shopify-evidence-batch` per-run duration falls from ~135s to ~90s, adjusted for the separate region move to us-west-2 if it lands in the same window.
- No `shopify_content_mutated` failures in the Klaviyo match.

Then decide whether phase 2 is still worth doing.
