# Booking Amendments — Design Spec

> Status: design only, not implemented. Captured here so future builds can move directly to coding.
> Owner: Miguel. Last reviewed: 2026-05-15 (drafted during v74a build).

---

## What problem this solves

After a booking is confirmed and the deposit is paid, real-world things happen:

- Guest wants to upgrade their room (Luxury → Panoramic Suite, total $1000 → $1500)
- Guest wants to change dates (still same room, different week)
- Guest wants to add a night or two
- Guest wants to downgrade (rare, but it happens)

Today, none of these are handled by the platform. The only path is:

1. Guest emails the property
2. Partner emails admin
3. Admin manually patches the booking record in KV and issues a new Stripe payment link

This is fine at zero volume. At any non-trivial volume it stops being fine. This document captures the design for handling amendments natively.

---

## What an amendment is (and is not)

**An amendment is:** a structured proposal from the partner to modify an already-paid booking. It links to the original offer, captures the delta (price, dates, room, party size), requires guest approval, and on approval triggers either a delta charge (upgrade) or a refund (downgrade).

**An amendment is not:**

- A new offer. Offers happen pre-payment; amendments happen post-payment.
- A cancellation. Cancellation is a separate flow with its own policy.
- A re-quote. Re-quotes happen during the enquiry → offer phase, before any money has changed hands.

The distinction matters because the *audit trail* of an amendment is different. The original offer was accepted and paid for; the amendment doesn't erase that — it layers on top.

---

## Data model

### New offer lifecycle state

Existing states (from envoy.js comments around line 3556):
```
draft → sent → accepted | declined | changes_requested | superseded | expired | withdrawn
```

Add one state and rename one:

```
draft → sent → accepted | declined | changes_requested | superseded | superseded_by_amendment | expired | withdrawn
```

- `superseded_by_amendment` — this offer was accepted AND paid AND subsequently amended. The original record is preserved unchanged for audit (the guest actually agreed to and paid for this version at the time).

### New offer fields (only set on amendment offers)

```json
{
  "amendment_of": "offer_xxx",
  "amendment_kind": "upgrade" | "downgrade" | "date_change" | "duration_change" | "party_change" | "mixed",
  "delta_total": 500,
  "delta_deposit": 75,
  "previous_state": {
    "room": "Luxury Room",
    "arrival": "2026-10-15",
    "departure": "2026-10-22",
    "guests": 2,
    "total_amount": 1000,
    "deposit_amount": 300
  }
}
```

`previous_state` is denormalised intentionally — preserving it on the amendment record means we don't need to walk the chain to know what changed.

### Booking record changes

```json
{
  "amendments": ["offer_yyy", "offer_zzz"],
  "active_offer_id": "offer_zzz"  // updated to point at the latest accepted amendment
}
```

The booking record's `total_amount`, `deposit_amount`, `arrival`, `departure`, `guests`, `room` always reflect the **currently-effective** state. To see history, look at the chain of offers in `amendments[]`.

---

## Stripe handling

### Upgrades (delta charge)

Use a new `PaymentIntent` for the delta. **Not** a new full charge with refund of the old.

Rationale:
- Most accurate to reality (a $300 deposit and a $75 incidental are two real events)
- No "you've been refunded" confusion email to guest
- No brief window where guest's card shows $0 paid
- Simpler reconciliation in the Stripe dashboard

Implementation:
- New endpoint `POST /api/amendment/checkout` that creates a Stripe Checkout session for the delta
- Webhook listens to `payment_intent.succeeded` (this is the dashboard subscription we'd actually need)
- On payment success: amendment offer flips to `accepted`, original offer flips to `superseded_by_amendment`, booking record updates atomically, `booking_amended` system card posts in conversation

### Downgrades (refund of difference)

Defer until policy is written. Open questions:

- Who absorbs the Stripe fee on the refunded portion?
- Is there a time window after which downgrades require approval / are not refundable?
- Does the partner have to approve the refund or is it automatic on guest acceptance of a partner-issued amendment?

Until these are answered, downgrades are still handled manually.

### Date changes / duration changes / party-size changes

These can be price-neutral (same room, different dates, same total) or price-shifting. Treat the same as upgrades/downgrades depending on whether `delta_total` is positive, zero, or negative.

Price-neutral changes (delta = 0) don't go through Stripe at all — just the data update on guest approval.

---

## UI flow

### Partner side (pp-bookings.html and/or pp-conversations.html)

On a booking with `paymentStatus: 'deposit_paid'`, partner sees an "Amend booking" button. Click opens an amendment builder modal:

- Pre-filled with current booking state
- Partner edits: room, dates, guests, total
- System auto-calculates `delta_total` and `delta_deposit`
- Amendment kind auto-detected from what changed
- Partner adds a note ("Upgraded to suite at guest's request")
- Submit → creates amendment offer with status `sent`, posts `amendment_card` system message in conversation

### Customer side (conversations.html and /bookings.html)

When an amendment_card lands in their conversation, the guest sees a structured card showing:

- Old state → new state (side-by-side rows)
- Delta clearly highlighted (e.g. "+$500 total · $75 additional deposit due")
- Two buttons: "Approve & pay $75" / "Decline"

On `/bookings.html` the booking row shows a pending amendment with the same info.

On approve:
- Delta > 0: Stripe Checkout for the delta
- Delta = 0: Direct accept, no Stripe step
- Delta < 0: Direct accept, refund queued (deferred — not built initially)

### Conversation system messages

Three new message types:

- `amendment_card` — partner posts (rendered like offer_card but with delta-focused layout)
- `amendment_accepted` — system card after guest approval + payment (celebratory but understated — booking updated, not booking confirmed)
- `amendment_declined` — system card after guest decline (muted, similar to offer_declined treatment)

---

## Email design

Three new transactional emails:

1. **Guest** when partner submits amendment — "Your booking has a proposed change" / subject: `Proposed change to your {Property} booking · {Ref}`. Branded shell, before/after summary, CTA to approve/decline.

2. **Guest** on amendment confirmed — "Your booking has been updated" / subject: `Booking updated · {Property} · {Ref}`. Shows new state + reference.

3. **Partner + admin** on amendment confirmed — "Amendment approved & deposit settled" / subject: `[CONFIRMED] Amendment · {Property} · {Ref}`. Internal email, ops triage tone.

---

## Build order (when ready)

**Build 1 — Data model + UI (no Stripe):**
- Worker: offer lifecycle additions, amendment endpoints, system message types, GET filters
- pp-bookings: amendment builder modal
- conversations.html / admin-conversations.html / pp-conversations.html: amendment_card rendering
- Approve path stubs Stripe — emails partner saying "guest approved, please manually invoice for delta"
- This alone makes the feature usable while Stripe is wired

**Build 2 — Stripe delta-charge integration:**
- Stripe webhook subscribes to `payment_intent.succeeded` in dashboard
- New `POST /api/amendment/checkout` endpoint
- Webhook handler updates booking + offer records atomically
- Replaces the manual-invoice stub from Build 1

**Build 3 — Downgrades + refund policy:**
- Deferred until written downgrade policy exists
- Stripe refund issuance
- `amendment_kind: 'downgrade'` UI distinct treatment

---

## Open questions to resolve before Build 1

1. Can partner amend an unpaid booking? (probably no — that's just editing the offer pre-acceptance)
2. Can partner amend a checked-in booking? (probably yes, but with a different visual treatment — "Mid-stay change")
3. Does amendment require any admin approval, or is it partner-direct-to-guest? (instinct: partner direct, admin loops in via loop-in feature if needed)
4. Can a guest *request* an amendment instead of partner proposing one? (out of scope for v1 — guest requests via conversation message, partner formalises)
5. What happens if a partner submits a downgrade amendment with `delta_total < 0` and `amendment_kind: 'downgrade'` before Build 3 lands? (worker should reject `delta_total < 0` until downgrade flow exists)

---

## Related: the "loop-in" feature

Amendment handling is one of the workflows the partner-to-admin loop-in feature (shipped in v74a) is designed to support. A partner who isn't sure how to handle a complicated amendment can loop in The Bearing privately within the conversation. So the manual path before Build 1 ships is: partner uses loop-in, asks admin, admin handles in Stripe + KV directly.
