# Judgment — J2, design-systems lead

Lens: does it live inside the app we already have (left sidebar, Figtree, cyan, warm neutrals,
light + dark), does it reuse components instead of inventing a language, does it pass an a11y
review, and can one dev actually ship it in five working days.

---

## D1 — "The Queue" (keyboard-first ops)

| Morning | Truth-first | Buildability | Earns its pixels | Total |
|---|---|---|---|---|
| 8 | 9 | 9 | 8 | **34** |

This is the one I could hand to a single developer on Monday without a kickoff meeting. It is
the existing `sidebar` primitive with `side="right"`, `collapsible="icon"`, its own cookie key —
which means collapse, persistence, and the mobile Sheet all arrive free and, more importantly,
*behave identically to the left rail the user already knows*. Nothing new enters the type system:
Figtree for prose, `font-mono tabular-nums` for frozen numbers, and that's the whole spec. The
a11y story is the strongest of the four and it's strong for the right reason — "zero hover-only
actions," severity as text plus glyph, keyboard-only focus rings, `listbox`/`option` semantics.
The Shopify-down state is the detail that tells me a real designer wrote this: dimming stale rows
to 60% and *disabling resolve on them with the reason inline* is a truth-first behavior nobody
asks for in review and everybody notices in use. My only real reservation is that the payoff is
tuned for an operator who lives in `j e j e`, and Reviv's morning reader may be a marketer who
clicks; D1 answers that honestly (mouse parity, no hidden affordances) rather than hand-waving,
so it costs a point, not a rank.

**Steal this:** disabled `Resolve`/`Mute` on stale rows, with the reason printed in the row —
you cannot close a finding computed from numbers that stopped moving.

---

## D2 — "The Ledger" (calm computing)

| Morning | Truth-first | Buildability | Earns its pixels | Total |
|---|---|---|---|---|
| 8 | 9 | 9 | 7 | **33** |

Typographically the most disciplined submission and the one that would photograph best in the
marketing site. Hairlines instead of cards, one 2px `border-l-destructive` as the entire severity
language, a dateline sentence instead of a badge — all of that is *less* CSS than the alternatives
and it sits on warm neutrals like it was always there. "Everything ties out. / $6,820 accounted,
seven buckets, no exceptions." is the single best piece of copy in the whole set; that's an earned
all-clear built out of type, not illustration. Two systems notes keep it off the top step. First,
actions behind a hover-revealed `⋯` — `focus-within:opacity-100` rescues keyboard users and I
believe the intent, but a control that isn't there until you approach it is the pattern our own
review checklist flags, and on touch it's a coin flip. Second, warning severity rendered as
`border-foreground/25` will be invisible in dark theme against `bg-sidebar`; that's a contrast
finding waiting to happen. And by choosing "no open state, the Ledger's job ends at the doorway,"
D2 argues itself closest to being a well-set page section that happens to be persistent — it's
the right call for calm, but it is the weakest case for the pixels.

**Steal this:** rows that become their own receipt — "Muted until 5 Aug · Undo" *in place* of the
row, no toast, nothing sliding.

---

## D3 — "THE TAPE" (data density)

| Morning | Truth-first | Buildability | Earns its pixels | Total |
|---|---|---|---|---|
| 6 | 9 | 5 | 9 | **29** |

The best *argument* in the set and the most expensive answer to it. The rule tape — five rules,
each with measured value against threshold, permanently visible — is the definitive solution to
"all clear must feel earned," and the always-mounted sync clocks are the clearest justification
anyone gave for a panel that cannot be a page section: status is not navigation, and a rail you
can hide is a rail that is hidden. I'd defend that thesis in a client meeting. Then I have to cost
it. It introduces a second font (`--font-mono` across an entire region), a new 11/12/13px scale
below our smallest token, red-background uppercase severity swatches, `SCREAMING_SNAKE` rule ids,
dimmed-red text for failures, plus `react-hotkeys-hook` and `vaul` snap points. That is a bespoke
design language living inside our app, and 11px mono with dimmed-red on `bg-muted/40` will not
survive a contrast pass in either theme. The seven-day plan is itself the confession — this brief
was five. It also asks the sync job to publish live measured values and 3-day series for all five
rules, which is backend work priced at zero here. For a small e-commerce team's five-minute check,
four lines per row plus a tape plus two ticking clocks is more instrument than the morning needs.

**Steal this:** the rule tape, and specifically that a muted rule *keeps showing its live reading*
— muting an alert must not blind the instrument.

---

## D4 — "Notification Center" (consumer notif)

| Morning | Truth-first | Buildability | Earns its pixels | Total |
|---|---|---|---|---|
| 7 | 8 | 9 | 6 | **30** |

Cheapest to build and cheapest to explain: Accordion for expansion (keyboard and ARIA free),
`Badge` in the topbar, `rounded-xl border bg-card`, a polite live region, 44px targets, and a
correct instinct that `sonner` is wrong because it covers the content you're verifying against.
Cutting swipe-to-dismiss — the most familiar gesture available — because resolving is a claim
about a business fact is the most principled call any of the four made. But the design fights the
constraint it was given. The client said *persistent panel*; D4 delivers a bell-toggled
`collapsible="offcanvas"` tray that is closed everywhere except Attribution and collapses to 0px,
and then duplicates the count in a topbar badge — which is exactly the "teach people to dismiss it
twice" failure D1 and D2 both named and refused. Docking a phone tray to a desktop analysis screen
also imports its economics: 12px radii, 16px padding and 12px card gaps mean roughly three
findings before scroll in a panel whose honest content is one line, and the EARLIER group puts
resolved items in the same visual stack as live ones. Well made, slightly the wrong product.

**Steal this:** rejecting swipe-to-dismiss on mobile — buttons only, because an undoable-but-
invisible gesture invites accidental resolution of a business fact.

---

## Ranking

1. **D1 — The Queue** (34)
2. **D2 — The Ledger** (33)
3. **D4 — Notification Center** (30)
4. **D3 — THE TAPE** (29)

**Winner: D1.** It is the only submission that is entirely built out of components we already
ship, passes an a11y review as written, and fits the week — then borrow D2's all-clear receipt
copy and D3's rule tape as the panel's footer, in Figtree, at our existing type sizes.
