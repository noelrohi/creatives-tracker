# J3 — the information-architecture skeptic

My test is not "is this pretty." My test is: on a Tuesday in month two, with zero findings, on a
13-inch laptop, does this panel deserve the 340–360px it took from the waterfall — the waterfall
being, let us remember, the entire product. Three of four designs pass. One of them is a bell.

---

## D1 — "The Queue" (keyboard-first ops)

| Morning | Truth | Build | Pixels | Total |
|---|---|---|---|---|
| 8 | 9 | 9 | 7 | **33** |

**Verdict.** This is the only submission that treats its own emptiness as the expected case and
designs for it without flinching — "empty must be the loudest state in the app… no illustration, a
timestamp" is the sentence I was waiting for from all four. It survives month two because it can
be shrunk to a 44px gutter that still carries the count, and the collapse persists, which is the
only honest answer to rent: let the tenant leave when there's nothing to say. Six findings scroll
fine; both syncs down is genuinely thought through, and disabling `resolve` on findings computed
from frozen numbers is the sharpest truth-fidelity move in the whole set — nobody else noticed you
can't resolve a conclusion drawn from a stopped clock. The 1024–1280 overlay rule means the 13-inch
case doesn't crush the waterfall. Where it loses: the justification for *persistence* is thinner
than it thinks. "Pixel-stable so the cited number stays on screen" is real, but at 0 findings, 300+
days a year, this is a 360px column showing a timestamp — and the design's own escape hatch
(collapse) quietly concedes it. It earns its pixels by being cheap to evict, not by being
indispensable.

**Steal this:** stale findings dim to 60% and their triage actions disable with the reason inline.

---

## D2 — "The Ledger" (calm computing)

| Morning | Truth | Build | Pixels | Total |
|---|---|---|---|---|
| 8 | 9 | 9 | 6 | **32** |

**Verdict.** The most disciplined document here and the one I'd most enjoy using in month six —
"the honest answer on most days is one line long" is correct IA reasoning, and refusing an in-panel
expand ("two surfaces for one finding means a reader who never knows if they've seen it all") is a
genuinely load-bearing cut, not a stylistic one. The all-clear receipt — `$6,820 accounted, seven
buckets, no exceptions` — is the best earned-clear in the set; it states the identity rather than
drawing a checkmark. But the skeptic's question bites hardest here: a panel that is purely
*read-only marginalia*, that explicitly ends its job "at the doorway," is precisely the artifact
that a page section would serve equally well. Persistence buys you nothing that a sticky block
under the waterfall wouldn't. And hiding the only triage affordance behind hover-reveal `⋯` is a
real defect at any width — on a 13-inch trackpad it's a scavenger hunt, and it undercuts the claim
that this panel is where decisions get made.

**Steal this:** the all-clear receipt stating the identity itself, not "you're all caught up."

---

## D3 — "The Tape" (data density)

| Morning | Truth | Build | Pixels | Total |
|---|---|---|---|---|
| 8 | 8 | 6 | 9 | **31** |

**Verdict.** This is the only entry that actually answers my question instead of dodging it. The
rule tape — five rules, measured value, threshold, pass/fail, permanently — means the panel is
never empty, which converts "findings inbox" (episodic, therefore a page section) into "annunciator"
(continuous, therefore a rail). That is a legitimate pattern change and it is the correct one; all
clear as five green readings rather than a blank column is the single best idea across all four
submissions. Muting an alert while the tape keeps showing the live measured value is a small piece
of moral clarity. Where it loses badly is discipline: `collapsible="none"` on a 340px rail is the
designer deciding for a user on a 13-inch screen that the waterfall gets ~640px forever, and the
live-ticking sync clocks duplicate the topbar freshness caption — two places to read the same fact
is exactly the IA sin the rest of the doc is preaching against. The build plan is seven days for a
one-week budget, and it adds a mono font, vaul, and a hotkeys library on top. Month two, the tape
becomes wallpaper — but wallpaper you can read in a glance is still better than an empty box.

**Steal this:** the always-visible rule tape. Whichever design ships, this is what makes all-clear
feel earned and makes the rail worth mounting.

---

## D4 — "Notification Center" (consumer notif)

| Morning | Truth | Build | Pixels | Total |
|---|---|---|---|---|
| 6 | 6 | 8 | 4 | **24** |

**Verdict.** Borrowing the phone's notification tray borrows its outcome: a surface people are
trained to clear without reading. The tell is that this design doesn't believe in its own
constraint — collapsed is 0px, default closed off-route, and the real persistent object is a bell
badge in the topbar. That's a tray, not a second sidebar; the brief's non-negotiable has been
negotiated. Then it fills the panel it doesn't trust: an EARLIER group of already-resolved findings
exists so that 360px of cards don't look empty, which is padding the inbox, and a soft cyan
checkmark circle for all-clear is decoration where the other three put an audit line. 16px padding
plus 12px gaps means two findings consume a full column on a 13-inch screen; six findings scroll
immediately. Truth-first is present but shallower — "no data" appears, frozen numbers appear, but
nothing here reckons with the Shopify-down case beyond an amber top border, and resolving a finding
drawn from stale numbers stays available. The a11y live region and the honest cut of
swipe-to-dismiss ("an undoable-but-invisible gesture invites accidental resolution") are the two
places this doc thinks hardest.

**Steal this:** cutting swipe-to-dismiss because resolving is a claim about a business fact.

---

## Ranking

1. **D1 The Queue** — 33
2. **D2 The Ledger** — 32
3. **D3 The Tape** — 31
4. **D4 Notification Center** — 24

**Winner: D1 "The Queue"** — the most buildable design that is honest about being empty most
mornings; graft D3's rule tape into it and the rail stops needing an excuse for its 360px.
