# TheBearing.io — Site Audit & Punchlist
> Created: 2026-06-24 (after v75n) · Status snapshot of what's broken / placeholder / unverified.
> Check items off as they're resolved. Add the build number that closed each one.

**How to read this:** Three buckets — (1) placeholder content on public pages, (2) dead/non-functional controls, (3) real-but-not-live features needing config or a follow-up build. Section 4 is the confirmed-working list (no action needed, kept for reference).

Audit method note: this was a *static code scan*. "Makes a real API call" means the wiring is correct, not that each endpoint was confirmed returning good data in production. The placeholder findings (§1, §2) are definite — they're hardcoded in the HTML. The §3 items need live verification.

---

## 1. Placeholder content on public pages — HIGHEST PRIORITY
> Fake/invented luxury properties with real-looking prices and dead buttons on the public storefront. Violates the no-dummy-data / real-properties-only rule. This is the public face of the brand.

- [x] **index.html** — fake property cards removed, cruise + hotel sections wired to KV with hide-if-<2 rule — **v75o**. *Remaining on this page:* "Bonus experience" section still has two invented "Coming soon" cards (Bali, Rwanda) and the "From the collection" guides are journal placeholders — tracked separately below.
- [ ] **index.html — Bonus Experience section** — "Coming soon · Bali" and "Coming soon · Rwanda" cards are invented experiences (honestly labeled, but still fiction). Replace with real NEN X experiences or remove.
- [ ] **the-bearing.html** — same fake-card pattern, ~10 "coming soon" refs. Clean up.
- [ ] **hotels.html** — 3 leftover demo cards / "See all → coming soon" buttons alongside the working KV loader. Remove the static extras.
- [ ] **villas.html** — 2 demo refs. Same.
- [ ] **cruises.html** — 1 demo ref. Same. (Nour El Nil flagship card is real — keep it.)
- [ ] **journal.html** — 5 "coming soon" refs; journal/guides appear to be placeholder posts. Decide: real content or remove the section until content exists.
- [ ] **the-envoy.html** — references "Amangiri · Utah" as an example property in AI landing copy. Replace with a real property or generic phrasing.
- [ ] **founding-member.html** — 1 "coming soon" ref. Review.
- [ ] **how-we-choose.html** — 1 "coming soon" ref. Review.

## 2. Dead buttons / broken navigation
- [x] **index.html dead demo-page refs removed — v75o** (VALID array cleaned; intercept made extension-agnostic for clean URLs). Still open in `collections.html` and `search.html`:
- [ ] **Missing demo property pages (collections/search)** — nav/route arrays still list files that DON'T EXIST: `amangiri.html`, `al-moudira.html`, `soneva-fushi.html`, `capella-ubud.html`, `aqua-nera.html`, `mekong-navigator.html`, `singita-grumeti.html`, `beyond-ngorongoro.html`, `alila-jabal-akhdar.html`, `amangiri-villas.html`, `al-moudira-estate.html`, `la-maison-bleue.html`. Any link to these 404s. Remove the dead references.
- [x] **"See all" buttons** wired to real pages (/hotels, /cruises, /journal) — v75o.
- [x] **"Inquire" on fake homepage cards** — gone with the fake cards; Inquire now only renders on real KV hotels — v75o.

## 3. Real features, not confirmed live (config or follow-up build, not placeholder)
- [ ] **Stripe payments** — code is complete (`/api/checkout/create-intent`, `/api/stripe/webhook`, `/api/checkout/sync-payment`) but depends on: (a) `STRIPE_SECRET_KEY` set in Cloudflare Pages env, (b) `payment_intent.succeeded` webhook subscribed in Stripe dashboard. Code itself flags this as "a known gap the operator must fix." **Verify it's actually live.**
- [ ] **Amendment deposit deltas** — explicitly a "Build 1 stub": when a booking is amended, the deposit difference is invoiced MANUALLY (admin gets a note to do it by hand). "Stripe wiring lands in Build 2." Build the automated path when ready.
- [ ] **Vectorize (Envoy RAG / L4)** — historically blocked on index creation. `admin-vectorize.html` is the management UI. Confirm whether the Vectorize index was ever created and the binding added; if not, Envoy isn't doing real RAG retrieval.
- [ ] **Customer confirmation email on enquiry** — was in the todo queue (earlier session). Confirm it sends.
- [ ] **`list-convs.html`** — debug/dump tool that now 403s post-v75i (calls bare `/api/conversation`, admin-only). Either admin-gate it properly or delete it.

## 4. Confirmed working (reference — no action)
- [x] Admin portal — real KV data throughout
- [x] Partner portal — complete through v75n (dashboard, listing, photos, rooms, experiences, team, availability-interim, booking-detail, conversations, notifications, settings)
- [x] Customer portal — bookings, conversations, my-account, lens, saved, preferences, settings
- [x] Auth — Clerk + JWT data-layer security (v75e–v75i): partner endpoints (?slug=) and customer endpoints (?ref=/?email=/?id=/?guestId=) all verified server-side
- [x] `/api/upload` gated to verified sessions (v75k)
- [x] Bookings, conversations, members — real KV data
- [x] admin-payments — fake GMV removed; honest "Stripe not configured" state
- [x] admin-analytics — rebuilt on real data (v72l)
- [x] search.html — demo cards removed (v74w); only real Nour El Nil card hardcoded
- [x] pp-settings — real nav hub + working sign-out (earlier "stub" note was stale)
- [x] Envoy AI, vibe-search, admin-credits — all make real API calls

---

## Known design decisions (NOT bugs — don't "fix")
- **nour-el-nil (hardcoded HTML page)** = design source of truth, Miguel's reference for matching editor-built pages. NOT a KV record. Kept deliberately separate from `nour-el-nil-x`.
- **nour-el-nil-x (KV record)** = the operational record the partner portal manages. Real bookings/enquiries attach here.
- **pp-availability** = intentionally an interim "handled via Conversations" page, NOT a blackout calendar — booking is enquiry-led, no instant booking. Becomes a real calendar when instant booking ships.
- **Booking model** = enquiry-led only. No instant booking in v1.

## Deferred future work (acknowledged, not blocking)
- [ ] Email-invite + verification flow for pp-team (via Clerk invitation API) — currently add-by-user-id grants immediate access. Needed before onboarding UNTRUSTED partners (current add is a privilege-escalation vector for that case).
- [ ] Channel-manager / iCal availability sync (Cloudbeds, SiteMinder) — paired with instant booking.
- [ ] Instant booking flow.
- [ ] Envoy L5 (cross-property RAG) / L6 (persistent per-user memory).

---
*Update this file as items are closed: check the box and note the build (e.g. "[x] index.html cleaned — v75o").*
