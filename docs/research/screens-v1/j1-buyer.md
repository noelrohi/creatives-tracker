# Judgment — j1, the Reviv media buyer

I buy media. I open this at 8am with coffee, I have about five minutes before the standup, and
what I need to know is: are yesterday's numbers real, and is anything on fire. Scored on that.

---

## D1 — "The Queue" (keyboard-first ops)

| Morning | Truth | Build | Earns pixels | Total |
|---|---|---|---|---|
| 8 | 9 | 9 | 8 | **34** |

This is the one I'd actually use on the fourth morning, not just the first. The count in the
header is a count of decisions I still owe, which is exactly how my brain treats the panel, and
`j e j e` clears a normal day before the kettle boils. Two things I genuinely respect: acting
from the *collapsed* row (I don't need to open a finding to know I already know about it), and
disabling resolve/mute on stale findings when Shopify is down — that's the first design here
that understood you can't close a ticket written against numbers that stopped moving. The
all-clear is two left-aligned lines and an audit stamp, which is the right amount of celebration
for a tool. My gripes are small: `o` opening evidence in the same tab means I'm leaning on
browser back all morning, and "Queue empty" is a bit cold for the state I see most often. Also
`⌥F` — nobody told me, but the hint is sitting right there in the header, so fine.

**Steal this:** stale findings can't be resolved or muted, with the reason printed inline.

---

## D2 — "The Ledger" (calm computing)

| Morning | Truth | Build | Earns pixels | Total |
|---|---|---|---|---|
| 7 | 9 | 9 | 8 | **33** |

Beautiful, honest, and slightly too polite for 8am. The thesis is right — read the identity
first, then see who objects — and "2 findings · after 06:12 sync" instead of a badge is the most
truthful count of the four: it tells me *when* the claim was made, which is the thing I actually
need before I quote a number in standup. No expand state at all is a brave call and I think it's
correct; the row is the whole finding and the link is the door. What costs it points is the `⋯`
menu hidden until hover. On a five-minute check I want to mute a rule I've already looked at
without hunting an invisible button in a 360px column, and "read-only until you hover" is how a
panel becomes decoration. Also `r` = mark resolved here but rerun sync elsewhere in the pack;
pick one and don't make me learn two. The all-clear receipt — "$6,820 accounted, seven buckets,
no exceptions" — is the best sentence anyone wrote in this whole set.

**Steal this:** the count as a sentence stamped with the sync that produced it, not a badge.

---

## D3 — "THE TAPE" (data density)

| Morning | Truth | Build | Earns pixels | Total |
|---|---|---|---|---|
| 8 | 9 | 5 | 10 | **32** |

Nobody understood the *second sidebar* constraint like this one. Two live sync clocks pinned at
the top and the five-rule tape pinned at the bottom means the rail is worth its 340px even on a
morning with zero findings — that is the whole argument for a persistent panel and this is the
only submission that actually makes it. The all-clear is five measured values against five
thresholds, all passing, and that is what "earned" means; the other three tell me nothing
happened, this one shows me the checks running. Two problems, and they're real. First, it talks
like a log file: `R1 CLAIM_RATIO`, `thr 2.00× Δ +0.11`, `d3/3`. I read Ads Manager, not stack
traces — I'd need someone to walk me through the rail once, and that's the thing I said loses
points. Second, the build is a seven-day plan with a new mono font, a hotkeys dependency, and
the most surface area of anything here, which in my experience means it lands in two weeks with
the mobile drawer unfinished. Muting an alert without blinding the instrument is dead right,
though.

**Steal this:** the always-visible rule tape — measured value vs threshold, all five rules,
including on all-clear.

---

## D4 — "Notification Center" (consumer notif)

| Morning | Truth | Build | Earns pixels | Total |
|---|---|---|---|---|
| 6 | 7 | 9 | 4 | **26** |

I clear notifications on my phone by swiping them away without reading them, and that is exactly
the habit I do not want near my revenue numbers. It's the most immediately legible panel of the
four and it would demo well, but it quietly gives back the constraint: a bell with a badge, an
offcanvas panel, closed by default everywhere but Attribution. That's a tray I can dismiss, not
a panel that's present while I work — and a dismissed tray is a page section with extra steps.
The EARLIER group of things already resolved is dashboard filler in a column this narrow; on a
day with two real findings I'm reading old wins to get to the footer. And the all-clear — a
cyan ✓ in a soft circle — is the one thing in this pack that feels *unearned*, which matters
because all-clear is my most common morning. Credit where due: cutting swipe-to-dismiss because
"mark resolved is a claim about a business fact" is the single most grown-up sentence in any of
these four documents, and the live region for count changes is the only accessibility thought
anyone had unprompted.

**Steal this:** buttons only, no gestures — resolving a finding is a claim, not a swipe.

---

## Ranking

1. **D1 — The Queue** (34)
2. **D2 — The Ledger** (33)
3. **D3 — THE TAPE** (32)
4. **D4 — Notification Center** (26)

**Winner: D1 "The Queue"** — it's the only one that's fast on the fourth morning as well as the
first; graft D3's rule tape onto its all-clear and D2's sync-stamped count sentence onto its
header and I'd ship it.
