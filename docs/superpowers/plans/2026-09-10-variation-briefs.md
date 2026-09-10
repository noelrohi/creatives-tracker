# Variation Briefs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the variation agent classify the source (funnel, lane, mechanics), pick one axis from a menu with diversity and performance rules, state a hypothesis, and be reviewed on whether the change is visible, so variations stop being reworded copies of the source.

**Architecture:** A new `setBrief` tool in the pure core (`src/lib/variation-agent.ts`) gates `generateImage`; the brief drives whether the source is attached as a layout reference and is stamped on the plan. The trigger loads the creative's earlier variations into the user content, passes the brief to the review, and adds a strategic checklist line. The card shows the brief.

**Tech Stack:** TypeScript, Vercel AI SDK tool loop, Drizzle, Vitest, Trigger.dev task `trigger/generate-variation.ts`.

Design: `docs/superpowers/specs/2026-09-10-variation-briefs-design.md`. Branch: `feat/variation-briefs` (cut from main). Commits are title-only (no body, no trailers). Do not touch `.gitignore`.

---

## File map

- Modify `src/lib/variation-agent-types.ts`: `VariationAxis`, `VariationFunnel`, `VariationBrief`, `EarlierVariation`; plan fields.
- Modify `src/lib/variation-agent.ts` (+ `variation-agent.test.ts`): `setBrief`, guard, axis-aware references, PROCEDURE, user content, plan stamping.
- Modify `trigger/generate-variation.ts`: earlier variations query, tool wiring, review.
- Modify `src/components/blocks/creatives/creative-variations-tab.tsx`: brief line.
- Modify `AGENTS.md` (Studio section, one sentence) and the design doc status at the end.

---

### Task 1: Types and schemas

**Files:**
- Modify: `src/lib/variation-agent-types.ts`, `src/lib/variation-agent.ts` (schemas only)
- Test: `src/lib/variation-agent.test.ts`

- [ ] **Step 1: Types.** In `variation-agent-types.ts` add:

```ts
export const VARIATION_AXES = ["hook", "angle", "funnel", "offer", "proof", "scene", "layout", "colour", "copy"] as const;
export type VariationAxis = (typeof VARIATION_AXES)[number];
export const VARIATION_FUNNELS = ["tof", "mof", "bof"] as const;
export type VariationFunnel = (typeof VARIATION_FUNNELS)[number];

/** The agent's classification of the source and the one test this variation runs. */
export type VariationBrief = {
  funnel: VariationFunnel;
  /** Format lane: product-led routine, testimonial card, before/after, offer badge, mechanism explainer, comparison, lifestyle, ugc. */
  lane: string;
  /** One sentence: what creates stopping power, comprehension, and purchase intent in the source. */
  mechanics: string;
  /** Elements that must not change. */
  locked: string[];
  axis: VariationAxis;
  /** "By changing X while keeping Y and Z, we expect A because B." */
  hypothesis: string;
};

/** An earlier variation of the same creative, shown to the agent so it rotates axes. */
export type EarlierVariation = {
  axis: VariationAxis | null;
  hypothesis: string | null;
  summary: string | null;
  mark: "good" | "bad" | null;
  status: "ready" | "failed" | "generating";
};
```

Add to `VariationPlan` (all optional, old rows lack them): `funnel?: VariationFunnel | null; lane?: string | null; axis?: VariationAxis | null; hypothesis?: string | null;` with the doc "Copied from the brief at finish."

- [ ] **Step 2: Schema.** In `variation-agent.ts` export:

```ts
export const setBriefInputSchema = z.object({
  funnel: z.enum(VARIATION_FUNNELS).describe("tof: problem recognition or curiosity; mof: mechanism, education, comparison, objection handling; bof: price, offer, urgency, guarantee, strong proof."),
  lane: z.string().min(1).describe("Format lane, e.g. product-led routine, testimonial card, before/after, offer badge, mechanism explainer, comparison, lifestyle, ugc."),
  mechanics: z.string().min(1).describe("One sentence: what creates stopping power, comprehension, and purchase intent in the source."),
  locked: z.array(z.string()).describe("Elements that must not change: the product, a verified offer, the disclaimer, the logo, any user constraint."),
  axis: z.enum(VARIATION_AXES).describe("The one thing this variation tests."),
  hypothesis: z.string().min(1).describe('"By changing X while keeping Y and Z, we expect A because B."'),
});
```

`variationPlanSchema` is unchanged (the brief is stamped by the core, not supplied by the model). `VariationRunInput` gains `earlierVariations?: EarlierVariation[]`.

- [ ] **Step 3:** `bun run typecheck`; commit `feat(studio): add variation brief types and schema`.

---

### Task 2: Agent core: setBrief, axis rules, prompt, plan stamping

**Files:**
- Modify: `src/lib/variation-agent.ts`
- Test: `src/lib/variation-agent.test.ts`

- [ ] **Step 1: Failing tests.** Add fixtures `const brief = { funnel: "mof" as const, lane: "product-led routine", mechanics: "Recognisable morning routine grid makes the product feel like an obvious upgrade.", locked: ["product", "disclaimer"], axis: "scene" as const, hypothesis: "By moving the routine to a bathroom counter while keeping the copy and CTA, we expect higher CTR because the scene reads as real life." };` and `const copyBrief = { ...brief, axis: "copy" as const };`. Tests:

```ts
describe("createVariationRun.setBrief", () => {
  it("refuses generateImage until the brief is set, then records it", async () => {
    const run = createVariationRun(input, deps());
    await expect(run.generateImage({ prompt: "p", referenceImageIds: [], keepSourceLayout: true })).resolves.toMatchObject({ error: expect.stringContaining("Set the brief first") });
    await expect(run.setBrief(brief)).resolves.toEqual({ ok: true });
    expect(run.state.brief).toEqual(brief);
    const result = await run.generateImage({ prompt: "p", referenceImageIds: [], keepSourceLayout: true });
    expect(result).toMatchObject({ attempt: 1 });
  });

  it("drops the source layout reference on scene, layout, angle, and funnel axes and says so", async () => {
    const d = deps();
    const run = createVariationRun(input, d);
    await run.setBrief(brief);
    const result = await run.generateImage({ prompt: "p", referenceImageIds: [], keepSourceLayout: true });
    expect(d.produceImage).toHaveBeenCalledWith(expect.objectContaining({ referenceImageUrls: ["https://blob.test/product.png"] }));
    expect(result).toMatchObject({ sourceLayoutIgnored: true });
  });

  it("keeps the source layout reference on the other axes", async () => {
    const d = deps();
    const run = createVariationRun(input, d);
    await run.setBrief(copyBrief);
    const result = await run.generateImage({ prompt: "p", referenceImageIds: [], keepSourceLayout: true });
    expect(d.produceImage).toHaveBeenCalledWith(expect.objectContaining({ referenceImageUrls: ["https://blob.test/product.png", "https://cdn.test/source.png"] }));
    expect(result).not.toHaveProperty("sourceLayoutIgnored");
  });

  it("passes the brief to the review and stamps it on the plan", async () => {
    const d = deps();
    const run = createVariationRun(input, d);
    await run.setBrief(brief);
    await run.generateImage({ prompt: "p", referenceImageIds: [], keepSourceLayout: true });
    expect(d.reviewImage).toHaveBeenCalledWith(expect.objectContaining({ brief }));
    await run.finish({ plan });
    expect(run.state.plan).toMatchObject({ funnel: "mof", lane: "product-led routine", axis: "scene", hypothesis: brief.hypothesis });
  });

  it("stamps the brief on a synthesized plan too", async () => {
    const run = createVariationRun(input, deps());
    await run.setBrief(brief);
    await run.generateImage({ prompt: "p", referenceImageIds: [], keepSourceLayout: true });
    const outcome = resolveVariationOutcome(run.state);
    expect(outcome).toMatchObject({ kind: "ready", plan: { synthesized: true, axis: "scene", funnel: "mof" } });
  });

  it("lets a second setBrief replace the first before any image, not after", async () => {
    const run = createVariationRun(input, deps());
    await run.setBrief(brief);
    await expect(run.setBrief(copyBrief)).resolves.toEqual({ ok: true });
    await run.generateImage({ prompt: "p", referenceImageIds: [], keepSourceLayout: true });
    await expect(run.setBrief(brief)).resolves.toMatchObject({ error: expect.stringContaining("already generated") });
  });
});
```

And in `buildVariationSystemPrompt`: `expect(system).toContain("setBrief")`, `expect(system).toContain("EARLIER VARIATIONS")` is for user content: in `buildVariationUserContent`, with `earlierVariations: [{ axis: "scene", hypothesis: "By moving…", summary: null, mark: "good", status: "ready" }, { axis: null, hypothesis: null, summary: "Reworded the headline", mark: null, status: "failed" }]` expect the text to contain `EARLIER VARIATIONS (newest first):`, `- scene — "By moving…" — marked good — ready`, and `- unclassified — Reworded the headline — no mark — failed`; and with none, expect no `EARLIER VARIATIONS`. Also `expect(system).toContain("under 180 words")` and `not.toContain("under 120 words")`.

- [ ] **Step 2: Run** the file → new tests fail.

- [ ] **Step 3: Implement.**

State: `brief: VariationBrief | null` on `VariationRunState` (init null; update every test literal that builds a state object: add `brief: null`).

`setBrief(raw)`: if `state.attempts.length > 0` return `{ error: "The brief cannot change after an image was already generated; finish with what you have or generate again under the same brief." }`; else `state.brief = raw; deps.onStep("writing the brief"); return { ok: true }`.

`generateImage`: after the budget check and before the claims scan: `if (!state.brief) return { error: "Set the brief first (setBrief): classify the source, choose the axis, and state the hypothesis before generating." }`. Reference list: `const SOURCE_FREE_AXES: VariationAxis[] = ["scene", "layout", "angle", "funnel"]`; `const sourceFree = SOURCE_FREE_AXES.includes(state.brief.axis)`; attach the source only when `raw.keepSourceLayout && input.useSourceLayout && !sourceFree`; when `sourceFree && raw.keepSourceLayout` add `sourceLayoutIgnored: true, sourceLayoutIgnoredReason: "On the scene, layout, angle, and funnel axes the source is not sent as a layout reference: the composition comes from your prompt."` to the result. `reviewImage` input gains `brief: VariationBrief | null` (pass `state.brief`). `finish` and the synthesized plan stamp `funnel`, `lane`, `axis`, `hypothesis` from `state.brief` (null when absent).

`VariationRunDeps.reviewImage` type gains `brief`.

PROCEDURE (replace the whole constant):

```ts
const PROCEDURE = [
  "You are the variation agent for a paid-social creative team. You receive one existing static ad (the source) and produce exactly one new variation of it as a finished image, then a plan explaining what you did. A variation is a test: one deliberate change with a stated hypothesis, not a restyle and not a rewording.",
  "",
  "Procedure:",
  "1. Read the source image and its text. Inventory what is visible: logo, headline, subhead, labels, CTA, offer, price, disclaimer, the product and its count and placement, people, scene, palette, typography, hierarchy.",
  "2. Classify it: the format lane (product-led routine, testimonial card, before/after, offer badge, mechanism explainer, comparison, lifestyle, ugc); the funnel stage (tof: problem recognition or curiosity; mof: mechanism, education, comparison, objection handling; bof: price, offer, urgency, guarantee, strong proof); the message sequence (hook, explanation or proof, product, CTA); and its mechanics: what creates stopping power, what creates comprehension, what creates purchase intent. Separate the locked elements (product, verified offer, disclaimer, logo, any user constraint) from what may change. Flag factual risk: claims, prices, testimonials.",
  "3. Check the core context, especially the resolution log and playbook, for what worked and did not work in that lane. Read reference sections only when they add something specific (a testimonial to quote, a customer phrase to reuse).",
  "4. Choose ONE axis and write the hypothesis, then call setBrief. Axes: hook (the opening line or visual hook), angle (the argument: problem, mechanism, benefit, identity), funnel (move the ad to another stage), offer (how the offer is framed), proof (testimonial, numbers, comparison), scene (setting, props, lighting, the world the product sits in), layout (grid, hierarchy, where things sit), colour (palette and mood), copy (wording only). The hypothesis reads: By changing X while keeping Y and Z, we expect A because B.",
  "5. Write a finished image prompt and call generateImage. The prompt is self-contained and under 180 words, in this order: the deliverable and format; the funnel objective in one line; hierarchy and composition (what reads first, second, third, and where); the product rule from the mode block; palette, lighting, and mood; every word that appears in the image quoted exactly in double quotes, kept short; the logo, CTA, and any disclaimer; exclusions. End with: No other text. No watermarks, platform UI, or third-party logos. On the scene, layout, angle, and funnel axes the source is not sent to the image model, so describe the whole composition yourself.",
  "6. Read the review. If it failed, fix the specific problems and try once more: for 'only the words changed', redesign the scene or layout in the prompt rather than rewording. Then call finish with the attempt you are shipping. Finishing on an attempt the review rejected is allowed but bounces once; call finish again to confirm.",
  "",
  "Choosing the axis, in priority order:",
  "- A CONSTRAINT FROM THE USER that names a change sets the axis.",
  "- Edit distance follows performance. High ROAS or many purchases: the source is a control; keep its funnel, offer, and mechanics and test one entrance to them (hook, proof, colour). High CTR with low ROAS: attention without intent; repair message match or proof. Low CTR and low ROAS: a larger change is justified (scene, layout, angle). Few purchases: a signal, not a winner.",
  "- Rotate. EARLIER VARIATIONS lists what this creative already tested. Do not repeat an axis until every other sensible axis has been used; prefer axes whose earlier attempts were marked good; avoid a hypothesis that was marked bad.",
  "- copy is allowed only when the constraint asks for it or when scene and layout have both been used already. A synonym swap, a palette swap, or a reworded CTA is not a variation unless that is the deliberate test.",
  "- funnel keeps the source's stage unless the constraint asks to move it. Moving to tof removes price, urgency, and hard CTA language; moving to bof needs a verified offer from the brand profile.",
  "",
  "Rules:",
  "- Any CONSTRAINT FROM THE USER is a hard constraint, not a suggestion.",
  "- Cite in evidence at least one document you actually used (core documents count; use their documentId), and only documents and sections you actually read.",
  "- Never quote a testimonial verbatim if it states a definitive medical outcome; soften it while keeping it authentic.",
  "- Prefer moves the playbook supports: plain-language benefits, product-led minimal composition, soft claims (may / designed to support), ad-to-landing-page continuity.",
].join("\n");
```

TRANSPLANT block: replace "at about the position and size the product has in the source ad image" with "at about the position and size the product has in the source ad image when the source is attached (hook, offer, proof, colour, copy axes), or wherever your composition places the product, sized to read at a glance, on the scene, layout, angle, and funnel axes".

`buildVariationUserContent`: after the note line add, when `input.earlierVariations?.length`:

```ts
`EARLIER VARIATIONS (newest first):\n${input.earlierVariations.map((v) => `- ${v.axis ?? "unclassified"} — ${escapeContextText(v.hypothesis ?? v.summary ?? "no plan")} — ${v.mark ? `marked ${v.mark}` : "no mark"} — ${v.status}`).join("\n")}`
```

(the hypothesis is quoted in double quotes when present: `"${…}"`; the summary is not).

- [ ] **Step 4: Run** `bun run test -- src/lib/variation-agent.test.ts` (61 expected: 53 + 8), `bun run typecheck`, `bun run lint`. Existing tests that call `generateImage` without a brief must first call `run.setBrief(copyBrief)` (copy keeps the source attached, so reference-order assertions hold) — update them and say how many.
- [ ] **Step 5: Commit** `feat(studio): brief the variation before any image and rotate the axis`.

---

### Task 3: Trigger: earlier variations, tool wiring, strategic review

**Files:**
- Modify: `trigger/generate-variation.ts`

- [ ] **Step 1: Earlier variations.** After the source query, load up to ten earlier variations of this creative:

```ts
      const earlierRows = await db
        .select({ status: studioVariants.status, mark: studioVariants.mark, plan: studioVariants.plan })
        .from(studioGenerations)
        .innerJoin(studioVariants, eq(studioVariants.generationId, studioGenerations.id))
        .where(and(
          eq(studioGenerations.organizationId, payload.organizationId),
          eq(studioGenerations.kind, "variation"),
          eq(studioGenerations.sourceCreativeId, source.id),
          ne(studioGenerations.id, payload.generationId),
        ))
        .orderBy(desc(studioGenerations.createdAt))
        .limit(10);
      const earlierVariations: EarlierVariation[] = earlierRows.map((row) => ({
        axis: row.plan?.axis ?? null,
        hypothesis: row.plan?.hypothesis ?? null,
        summary: row.plan?.summary ?? null,
        mark: row.mark === "good" || row.mark === "bad" ? row.mark : null,
        status: row.status === "ready" ? "ready" : row.status === "failed" ? "failed" : "generating",
      }));
```

(check the real column and enum names in `src/schema/studio.ts` and adapt; `source.id` is the creative id already in scope). Pass `earlierVariations` in `VariationRunInput`.

- [ ] **Step 2: Tool wiring.** Add to `tools`:

```ts
              setBrief: tool({
                description: "Record the source classification (funnel, lane, mechanics, locked elements), the one axis this variation tests, and the hypothesis. Required before generateImage; may be replaced until the first image.",
                inputSchema: setBriefInputSchema,
                execute: (raw) => run.setBrief(raw),
              }),
```

- [ ] **Step 3: Review.** `reviewImage` destructures `brief`. For every generate attempt on a creative source attach the source as the second image (today only transplant attempts do); keep the asset third. Premise for a plain generate attempt with the source attached: "…The first image is the generated ad; the second is the source ad it varies." (keep the transplant and edit premises; they already name the source as second). Add, when `brief` is set, right after "Checklist (all must hold for pass = true):":

```ts
                brief
                  ? `- The variation declares axis "${brief.axis}": ${brief.hypothesis} Compare with the source: the change on that axis must be visible in the image, not only in the words. For scene, layout, angle, or funnel, the composition or setting must differ from the source; if only the copy changed, fail and say "only the words changed". For hook, offer, proof, colour, or copy, the named element must differ while the rest stays recognisably the same ad.`
                  : null,
```

(the hypothesis is operator-free model text; it is already escaped at the tool boundary by being model output, no `escapeContextText` needed, but keep it on one line by replacing newlines with spaces).

- [ ] **Step 4:** `bun run typecheck`, `bun run lint`, `bun run test -- src/lib/variation-agent.test.ts`. Commit `feat(studio): show the agent its earlier variations and review the declared axis`.

---

### Task 4: Card

**Files:**
- Modify: `src/components/blocks/creatives/creative-variations-tab.tsx`

- [ ] In `PlanDisclosure`, right after `<p>{plan.summary}</p>`:

```tsx
        {plan.axis || plan.funnel ? (
          <p>
            <span className="font-medium">Testing:</span> {plan.axis ?? "unclassified"}
            {plan.funnel ? ` · ${plan.funnel.toUpperCase()}` : ""}
            {plan.lane ? ` · ${plan.lane}` : ""}
            {plan.hypothesis ? ` — ${plan.hypothesis}` : ""}
          </p>
        ) : null}
```

- [ ] `bun run typecheck && bun run lint`; commit `feat(creatives): show what a variation is testing`.

---

### Task 5: Live check, verification, docs

- [ ] Live check (recipe as in `docs/superpowers/plans/2026-09-07-variation-empty-scene-transplant.md` Task 5 Step 7; creatives R3 `6a2c721d-4db5-4cbf-9e26-9555c96562d6`, R1 `f277659f-2965-488c-9b91-353dc25a5a5b`, R2 `c236089c-3a93-4323-a4fc-9d2cc0c53e86`; notes must read like real notes, e.g. "try a different angle" or none): R3 twice with no note (the second must pick a different axis than the first; both stored plans carry `axis` and `hypothesis`), R1 once with the note "change the scene to a bright morning bathroom" (axis must be `scene`, no source reference attached, composition visibly different), R2 once with no note. Record per run: axis, funnel, hypothesis, whether the source was attached, review pass and first note, and a visual judgement of how different the image is from the source. Stop the servers afterwards.
- [ ] `bun run typecheck && bun run lint && bun run test`, `node scripts/check-migrations.mjs` (no migration in this plan).
- [ ] Docs: `AGENTS.md` Studio bullet gains "variations declare a funnel, an axis, and a hypothesis (the `setBrief` tool)"; the design doc's status line becomes implemented with the live-check results. Commit `docs(studio): record the variation briefs outcome`.

---

## Self-review

- Design §1 (setBrief, fields, plan stamping, card) → Tasks 1, 2, 4.
- Design §2 (axis rules, diversity, copy restriction, funnel rule) → Task 2 PROCEDURE.
- Design §3 (source-free axes, TRANSPLANT sentence, 180 words, structure) → Task 2.
- Design §4 (review sees source and brief, strategic line, retry lever) → Tasks 2 (lever in PROCEDURE step 6) and 3.
- Design §5 (earlier variations with marks) → Tasks 1 (type), 2 (user content), 3 (query).
- Names used consistently: `setBrief`, `setBriefInputSchema`, `VariationBrief`, `EarlierVariation`, `state.brief`, `sourceLayoutIgnored`, plan fields `funnel`/`lane`/`axis`/`hypothesis`.
