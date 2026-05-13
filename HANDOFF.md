# TheBearing.io — Handoff Document
> Last updated: 2026-05-13 | Current build: v73m

---

## Project Overview
TheBearing.io is a curated luxury travel platform. Miguel is founder and works hands-on across product, design, and development. The site is a flat-file HTML/CSS/JS frontend deployed via Cloudflare Pages, backed by a single Cloudflare Worker (`functions/api/envoy.js`) that handles all API endpoints.

---

## Infrastructure

| Item | Value |
|------|-------|
| GitHub repo | `mcancino213/thebearing.io` |
| Deploy | Cloudflare Pages — push to `main` auto-deploys |
| Worker | `functions/api/envoy.js` |
| KV namespace | `DOSSIERS` (id: `aa0c885871474266966e50f0676dd019`) |
| CF Account ID | `d62dd7db798247bb6cc9ff18ff7ee84f` |
| CF Account Hash | `YyCqpmHo4EG6ShyDMCRcVQ` |
| CF Images token | `CF_IMAGES_TOKEN` (secret in worker) |
| Anthropic key | `ANTHROPIC_API_KEY` (secret in worker) |
| Live URL | https://thebearing.io |

## Workflow
1. Miguel describes changes
2. Claude makes them and packages a .zip
3. Claude provides terminal commands to apply the patch
4. Miguel pushes from GitHub Desktop to live

**Never deploy via local `wrangler` CLI** — always push to GitHub and let Cloudflare Pages build. Local Mac environment causes crashes.

---

## Tech Stack

- **Frontend:** Flat HTML/CSS/JS, no build step, no framework
- **Fonts:** Instrument Serif, Cormorant Garamond, Geist
- **CSS variables:** `--cream:#faf7f1`, `--ink:#1e1810`, `--terra:#b05830`, `--gold:#9a7230`, `--sand:#ece5d8`, `--stone:#7a6a58`, `--bark:#5a4a38`, `--moss:#4a6a48`
- **Worker:** Cloudflare Pages Functions (ESM)
- **Storage:** Cloudflare KV (`DOSSIERS` namespace)
- **Images:** Cloudflare Images (`imagedelivery.net/YyCqpmHo4EG6ShyDMCRcVQ/{id}/public`)

---

## Worker API Endpoints (`functions/api/envoy.js`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/envoy` | POST | Anthropic API proxy |
| `/api/property` | GET/POST/DELETE | Full property CRUD + index |
| `/api/dossier` | GET/POST | Property dossier text |
| `/api/itinerary` | GET/POST | Day-by-day itinerary JSON |
| `/api/source` | GET/POST/DELETE | URL fetch + KV cache for dossier sources |
| `/api/upload` | POST | Cloudflare Images upload |
| `/api/index` | POST/DELETE | Embed + upsert content into Vectorize / delete vectors |
| `/api/clerk-webhook` | POST | Clerk auth webhook handler |
| `/api/settings` | GET/POST | Admin-gated. Read/write notification recipients + allowlist extras. Stored at `__settings:notifications` and `__settings:allowlist` |
| `/api/settings/allowlist-public` | GET | **Unauthenticated**. Returns merged admin allowlist (baseline + KV extras). Read by `assets/admin-gate.js` on every admin page load |
| `/api/health` | GET | Admin-gated. Live status of KV / Resend / Vectorize / Workers AI / Anthropic / Clerk / cron last-run |

### KV Key Conventions
```
{slug}:property        → full property JSON
{slug}:itinerary       → itinerary JSON
{slug}:source:{n}      → cached source text (slots 1-10)
{slug}                 → dossier text (plain string)
__property_index       → JSON array of all slugs
__index_cruises        → JSON {slugs:[...]} curated cruise order
__index_hotels         → JSON {slugs:[...]} curated hotel order
__index_villas         → JSON {slugs:[...]} curated villa order
member:{id}            → member JSON
__members_index        → JSON array of member IDs
__settings:notifications → JSON {recipients:[email], updatedAt} — admin alert recipients
__settings:allowlist   → JSON {emails:[email], updatedAt} — extra admin sign-in addresses
__cron:last_run        → JSON {ranAt, durationMs, scanned, sent, ok, error?} — set by stale-conv cron each run
```

---

## Site Structure

### Public Pages (35 total)
| Page | Purpose |
|------|---------|
| `index.html` | Homepage |
| `the-bearing.html` | About |
| `cruises.html` | Cruise listing — 1 hardcoded card (Nour El Nil) + KV dynamic loader |
| `hotels.html` | Hotel listing — hardcoded cards + KV dynamic loader |
| `villas.html` | Villa listing — hardcoded cards + KV dynamic loader |
| `property.html` | **Universal property template** — hydrates from KV via `?slug=` param |
| `nour-el-nil.html` | Nour El Nil flagship page (standalone, full content baked in) |
| `vibe-search.html` | AI-powered vibe search |
| `the-envoy.html` | Envoy AI landing page |
| `bookings.html` | Booking management |
| `my-account.html` | User account |
| `search.html` | Search |
| ~12 demo placeholder pages | Not real — ignore, will be replaced by `property.html?slug=X` |

### Admin Pages
| Page | Purpose |
|------|---------|
| `admin-properties.html` | Property list + **Listing Order tab** (drag to reorder) |
| `admin-property-editor.html` | Full property editor (name, type, location, price, images, rooms, dossier, sources, itinerary) |
| `admin-dashboard.html` | Overview dashboard |
| `admin-guests.html` | Guest management |
| `admin-bookings.html` | Booking management |
| `admin-conversations.html` | Envoy conversation history |
| `admin-analytics.html` | Analytics |
| + 8 more admin pages | Standard CRUD |

### Partner Portal Pages (`pp-*.html`)
Standard partner-facing pages: dashboard, listings, bookings, photos, rooms, availability, etc.

---

## Property System

### How Properties Work
1. Created/edited in `admin-property-editor.html`
2. Saved to KV as `{slug}:property` JSON + indexed in `__property_index`
3. Public URL: `https://thebearing.io/property?slug={slug}`
4. `property.html` fetches KV on load and hydrates all sections

### Property JSON Shape (key fields)
```json
{
  "name": "Gypsy by Mekong Kingdoms",
  "type": "River Cruise",
  "location": "Mekong River, SE Asia",
  "price_from": 2900,
  "tagline": "...",
  "bearing_edit": "...",
  "photos": { "hero": [{"url": "..."}] },
  "rooms": [...],
  "included": [...],
  "tags": [...],
  "render": { "location_line": "Mekong River · SE Asia" }
}
```

### Listing Page Logic (cruises/hotels/villas)
1. Fetch `__index_{type}` — curated admin-set order
2. If curated list exists: render those slugs in that order (type filter still applied)
3. Append any remaining type-matched KV properties not yet shown
4. Hardcoded flagship cards always sit at top (e.g. Nour El Nil on cruises page)

---

## Envoy AI System

### Architecture

| Layer | Status | Description |
|-------|--------|-------------|
| L1 | ✅ Done | Page-aware system prompts with per-property context |
| L2 | ✅ Done | Dossier authoring tool in admin (interview-based) |
| L3 | ✅ Done | AI-assisted dossier draft generation with web search |
| L4 | ✅ Done | RAG via Cloudflare Vectorize — index created, bindings added, worker updated |

## Auth System (Clerk)
- Clerk test key: pk_test_bWVhc3VyZWQtam9leS0xNS5jbGVyay5hY2NvdW50cy5kZXYk
- Clerk domain: measured-joey-15.clerk.accounts.dev
- Shared auth helper: assets/auth.js
- tbAuth.requireUser(cb, opts) — checks Clerk, shows slide-up sign-in modal if not authed
- tbAuthEnquire(propertyName) — auth-gated enquiry opener
- tbAuthBook(config) — auth-gated booking opener
- All enquiry + book buttons on property pages gated

### Admin allowlist (as of v72g)
- **Baseline:** `admin@thebearing.io` — hardcoded in `functions/api/envoy.js` (`ADMIN_EMAILS_BASELINE`) and `assets/admin-gate.js`. Never removable through the UI; it's the failsafe so a bad settings edit can't lock everyone out.
- **Extras:** Stored in KV at `__settings:allowlist`. Edited from `admin-settings.html`. Read by the worker via `loadAllowlistExtras()` and by `admin-gate.js` via `/api/settings/allowlist-public` on every admin page load (3s cap, baseline-only on fetch failure).
- To add a new admin: sign in to admin-settings.html → section 2 → add email → save. Takes effect on that admin's next page load (no redeploy)


## Booking System
- /api/booking — POST saves to KV, GET lists all, PATCH updates status
- KV key: booking:{ref}, index: __bookings_index
- Email via Resend (RESEND_API_KEY secret in worker)
- admin-bookings.html — real KV data, filter/confirm/cancel
- Pricing: roomPrice is per-trip flat rate
- **Recipient emails** for all operational admin alerts (booking, enquiry, conv reply, inbound email, 48h/72h stale escalation) are configurable from `admin-settings.html` and stored at `__settings:notifications`. `admin@thebearing.io` is always merged in as a baseline failsafe.

## Queued / Deferred (as of v72g)
- **admin-analytics wiring** — deferred until there's real traffic to chart. Page exists at `admin-analytics.html` but is a stub.
- **admin-payments (Stripe integration)** — deferred until there are real bookings to take payment for. Page exists at `admin-payments.html`.
- **L5 / L6 of Envoy roadmap** — global cross-property RAG index + persistent per-user memory. See section below.

| L5 | 🔲 Pending | Cross-property index for compare/recommend queries |
| L6 | 🔲 Pending | Persistent per-user conversational memory |

### L4 Vectorize Setup — BLOCKED
Cloudflare dashboard has no UI to create Vectorize indexes. Requires REST API call:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/d62dd7db798247bb6cc9ff18ff7ee84f/vectorize/v2/indexes" \
  -H "Authorization: Bearer {CF_TOKEN_WITH_VECTORIZE_EDIT}" \
  -H "Content-Type: application/json" \
  -d '{"name":"thebearing-properties","config":{"dimensions":768,"metric":"cosine"}}'
```

Need a CF API token with `Account → Vectorize → Edit` permission.
After index is created:
1. Add `VECTORIZE` binding in Pages → Settings → Functions
2. Add `AI` binding in Pages → Settings → Functions
3. Update `wrangler.toml` with both bindings
4. Update worker with `/api/embed`, `/api/vectorize` endpoints + upgrade `/api/envoy` to query vectors first

### Envoy Client Code
- Shared prompt: `assets/envoy-prompt.js`
- Each page has a `ci-drawer` FAB that opens the Envoy chat
- Property pages inject dossier + property data into system prompt
- Context pill shows current property name
- Suggestion chips hidden when conversation history exists

---

## Key Design Decisions & Gotchas

### Deployment
- **Always push to GitHub** — never `wrangler deploy` locally (Mac env causes crashes)
- File structure is flat — all HTML files in root, assets in `/assets`, functions in `/functions/api/`

### Mobile Overlays
- All `.sheet` overlays slide up from bottom on mobile (`≤767px`)
- `translateY(100%) → translateY(0)` CSS transition
- `tbOpenCheckout()` uses double `requestAnimationFrame` + `.open` class
- `tbCloseCheckout()` removes `.open`, waits 380ms before `display:none`
- X close button on all sheets, tap outside backdrop also closes

### Book Bar (all property pages)
- Dual buttons: **Book now** (triggers `.dbc-cta`) + **Enquire** (opens `inq-overlay`)
- Both on `property.html` AND `nour-el-nil.html` AND all 12 demo pages
- Mobile: `flex:1` so both share equal width

### Safari Backdrop-Filter Bug
- `backdrop-filter` on `display:none` elements still renders blur in Safari
- Fix: add `visibility:hidden` to `.overlay` + `visibility:visible` to `.overlay.open`
- Applied to all 12 old-template pages

### Listing Order
- Admin: `admin-properties.html` → Listing Order tab → drag to reorder → Save
- Saves `__index_cruises`, `__index_hotels`, `__index_villas` to KV
- `hasCurated` must be declared at IIFE outer scope — chained `.then()` callbacks don't share scope

### Image Handling
- All images via Cloudflare Images
- Delivery: `https://imagedelivery.net/YyCqpmHo4EG6ShyDMCRcVQ/{id}/public`
- No `nourelnil.com` images on any page except intentionally on `nour-el-nil.html`

### CSS Injection Rules
- Never inject CSS outside `<style>` tags (causes wall-of-code rendering)
- Always close `</style>` before opening new `<style>` block
- One FAB (`ci-fab`) per page maximum

---

## Current Real Properties in KV
| Property | Slug | Type | Page |
|----------|------|------|------|
| Nour El Nil | `nour-el-nil` | River Cruise | Standalone `nour-el-nil.html` |
| Gypsy by Mekong Kingdoms | `gypsy-by-mekong-kingdoms` | River Cruise | `property.html?slug=gypsy-by-mekong-kingdoms` |
| Singita Grumeti | `singita-grumeti-x` | Lodge | `property.html?slug=singita-grumeti-x` |

---

## Nour El Nil Mobile App (separate project)
- Repo: `mcancino213/nour-el-nil-app-repository`
- **Build via Expo dashboard only** — never local CLI
- Branch: `main`, profile: `testflight`
- Stable build: 1.0.0 (13), SDK 54
- Audio: `react-native-sound`, `.default` unwrap fix in `phraseAudio.ts`
- Hidden debug: 5-tap on "NOUR EL NIL" header → AudioDebugScreen (remove before ship)
- Open items: progress persistence, pulse/review POST endpoint, Day 6 content audit, meditation audio (friend recording), push notifications, Envoy AI integration

---

## Wrangler Config (`wrangler.toml`)
```toml
name = "thebearing-io"
main = "functions/api/envoy.js"
compatibility_date = "2024-09-01"

[assets]
directory = "./"
not_found_handling = "single-page-application"

[observability]
enabled = true

[[kv_namespaces]]
binding = "DOSSIERS"
id = "aa0c885871474266966e50f0676dd019"

# TO ADD after Vectorize index is created:
# [[vectorize]]
# binding = "VECTORIZE"
# index_name = "thebearing-properties"
#
# [ai]
# binding = "AI"
```

---

## Build History (recent)
| Build | Key changes |
|-------|-------------|
| v73m | **All four deferred items shipped.** (1) **Section tinted backgrounds + colored pills on /bookings.** Per Miguel's pick: Offers section is cream/terracotta tinted (`#fdf0e6 → #fbf5ec` with terracotta accent stripe), Enquiries is sand (`#f5ecd9 → #faf4e6` with sand accent), Confirmed is moss (`#e6efe2 → #f1f4ec` with moss accent). Each section is now its own panel — rounded corners, soft 1px border in the section's color family, gradient top stripe. Pills got the same color treatment: terracotta/sand/moss backgrounds with matching count badges in solid color, hover state pops the border. Offer cards inside the sections are now pure white (was gradient-to-cream) so they pop against the tinted panel. Page no longer feels monochrome. (2) **Cancel enquiry mechanism.** Worker: `PATCH /api/booking` with `{ref, action:'cancel-enquiry', requesterEmail}` — verifies email matches `booking.email` (or caller is admin), only allows cancellation from `enquiry`/`pending`/`offer_sent` status, sets `status:'cancelled' + cancelledAt + cancelledBy`, archives the linked conversation, and withdraws any active offer. Customer-side: enquiry rows now have a "Cancel" button (red text on transparent, hover fills red-tint) with a confirmation dialog. Bucketing skips `status:'cancelled'` and `status:'withdrawn'` so cancelled enquiries disappear from view. (3) **Admin batch: "Cancel stale pre-v73j enquiries"** button in admin-settings Maintenance section. Endpoint `/api/booking/cancel-stale-enquiries` (admin-gated POST) finds every enquiry/pending booking created on or before 2026-05-12 and cancels them in batch with full output report (cancelled refs, skipped reasons, errors). One-shot fix for Miguel's two stale Gypsy enquiries that pre-date the offer flow. (4) **Admin batch: "Backfill offer cards"** button in admin-settings Maintenance section. Endpoint `/api/offer/backfill-cards` (admin-gated POST) walks every sent offer, posts an `offer_card` message into the linked conversation if not already present. Idempotent. Skips archived conversations. Backfills cards for offers sent before v73j added auto-card-posting on send. (5) **Flash protection on lens/saved/preferences/settings.** All four customer-portal pages now have `body{visibility:hidden}` + `noscript` fallback at top of `<head>`, plus a proper Clerk-load handler that times out at 8s and falls back to a Compass branded back-to-bearing screen. Signed-out users see the Compass overlay with sign-in widget + Back-to-The-Bearing link, identical pattern to my-account and bookings. Page-specific copy ("Sign in to access your Lens" etc.) and `afterSignInUrl` matches each page. **All flagged-from-v73k items now resolved. Next build: Stripe Checkout integration for the Accept-and-pay button** |
| v73l | Interim: arrow-bug fix, redundant Room cell removed, sections reordered (Offers first), CSS hooks for v73m color treatment |
| v73k | Customer /bookings.html rewritten with real KV data + three sections. Offer detail modal ported from conversations.html. body-flash-protection on bookings |
| v73j | Enquiry message reformat. "Average nightly" labels. Save section defaults per property. Offer surfaces as card in conversation thread with full-detail modal |
| v73i | Second-enquiry silent-discard fix. Backfill endpoint for stub bookings. Auth modal Grid centering |
| v73h | "Your Cove" → "Your Compass" |
| v73g | Stub-booking on enquiry create + four smoke-test fixes |
| v73f | `?as=X` partner switching |
| v73e | Bulletproof sign-out, "On request" fallback |
| v73d | openEnquiry auth-gating |
| v73c | Killed Step 3 enquiry |
| v73b | property.html universal-template hardening |
| v73a | Adults/Children inputs |
| v72z | Critical: unclosed populateConfirmation() broke property.html |
| v73k | Customer /bookings.html rewritten with real KV data and three sections. Worker `/api/booking?email=` for customer-scoped lookup. Body flash-protection. Offer detail modal ported from conversations.html |
| v73j | Enquiry message reformat. "Average nightly" labels. Save section defaults per property. Offer surfaces as card in conversation thread with full-detail modal |
| v73i | Second-enquiry silent-discard fix. Backfill endpoint for stub bookings. Auth modal Grid centering |
| v73h | "Your Cove" → "Your Compass" |
| v73g | Stub-booking on enquiry create + four smoke-test fixes |
| v73f | `?as=X` partner switching |
| v73e | Bulletproof sign-out, "On request" fallback |
| v73d | openEnquiry auth-gating |
| v73c | Killed Step 3 enquiry |
| v73b | property.html universal-template hardening |
| v73a | Adults/Children inputs |
| v72z | Critical: unclosed populateConfirmation() broke property.html |
| v73j | Enquiry message reformatted (paragraph blocks instead of run-on sentence). "Average nightly" labels throughout offer builder. Partner can save section defaults per property (Inclusions, Cancellation terms, Notes). Offer surfaces as styled card in customer conversation thread + opens modal with full detail + Accept/Request actions |
| v73i | Second-enquiry silent-discard bug fixed. Backfill endpoint for stub bookings. Auth modal Grid centering |
| v73h | "Your Cove" → "Your Compass". Back-to-Bearing links on signed-out screens |
| v73g | Five smoke-test fixes including stub-booking on enquiry create |
| v73f | `?as=X` partner switching, OAuth resume sessionStorage, auth modal width bump |
| v73e | Bulletproof sign-out, "On request" fallback, price_indicator field |
| v73d | openEnquiry auth-gating, async Clerk resolution, hide empty From |
| v73c | Killed Step 3 enquiry. Listing-page enquiry redirects |
| v73b | property.html universal-template hardening |
| v73a | Adults/Children inputs |
| v72z | **Critical: unclosed `populateConfirmation()` broke property.html** |
| v73i | Second-enquiry silent-discard bug fixed (now posts as follow-up message). Backfill endpoint for stub bookings. Auth modal centering: CSS Grid with `place-items:start center` + explicit viewport dimensions |
| v73h | "Your Cove" → "Your Compass" rename. Clickable Bearing wordmark + Back-to-Bearing link on all signed-out screens |
| v73g | Five smoke-test fixes: my-account flash protection; auth modal align-items:flex-start; index.html bounces tb_pending_action; enquiry creates linked stub booking; PP identity dynamic |
| v73f | Auth modal max-width 480→560 + Loading placeholder removed + clean-URL paths. `tb_pending_action` sessionStorage for OAuth resume. `?as=X` partner switching |
| v73e | Bulletproof sign-out. Graceful "On request" fallback. price_indicator field |
| v73d | openEnquiry wraps tbAuth.requireUser. Robust Clerk-user resolution. Empty "From" hidden when no price |
| v73c | Killed Step 3 enquiry. Robust Clerk resolution. Listing-page enquiry redirects to property page. Inline error display |
| v73b | property.html universal-template hardening: removed kvHydrate IIFE, stashed window.PROPERTY_SLUG |
| v73a | Side-by-side Adults/Children inputs. Fixed undefined submitEnquiryAndGo |
| v72z | **Critical: unclosed `populateConfirmation()` function broke property.html** |
| v73h | "Your Cove" → "Your Compass" rename across my-account.html and conversations.html. Clickable Bearing wordmark + "← Back to The Bearing" link added to all six signed-out overlay screens so users aren't trapped |
| v73g | Five smoke-test fixes: my-account flash protection; auth modal `align-items:flex-start` for tall viewports; index.html bounces `tb_pending_action` to property; enquiry creates linked stub booking with `status:'enquiry'`; PP identity dynamic via `fetchPartnerIdentity()` |
| v73f | Auth modal max-width 480→560 + remove Loading placeholder + clean-URL paths in stayInPlace. `tb_pending_action` sessionStorage for post-OAuth resume. `?as=X` URL param for partner-as switching |
| v73e | Bulletproof sign-out (waits for Clerk, clears sessionStorage, hard-redirect with cache-bust). Graceful "On request" fallback. New `price_indicator` field |
| v73d | Auth race fix: `openEnquiry()` wraps `tbAuth.requireUser()`. Robust async Clerk-user resolution. Empty "From" hidden when no price |
| v73c | Killed Step 3 of enquiry flow. Robust Clerk user resolution. Listing-page enquiry buttons redirect to property page. Inline error display. Pre-existing villas.html duplicate `.catch()` cleaned up |
| v73b | Property.html universal-template hardening: removed obsolete `kvHydrate()` IIFE, stashed URL slug as `window.PROPERTY_SLUG`, replaced fake conversation preview on Step 3 |
| v73a | Side-by-side Adults/Children number inputs. Fixed undefined `submitEnquiryAndGo()`. Cleaned orphaned SVG debris |
| v72z | **Critical fix: property.html had an unclosed `populateConfirmation()` function** that broke the entire page. Bug pre-dated v72y |
| v73g | Five smoke-test fixes: my-account flash protection via `body{visibility:hidden}`; auth modal `align-items:flex-start` for tall viewports; index.html bounces `tb_pending_action` to property; enquiry creates linked stub booking with `status:'enquiry'`; PP identity dynamic via `fetchPartnerIdentity()` |
| v73f | Auth modal max-width 480→560 + remove Loading placeholder + clean-URL paths in stayInPlace. `tb_pending_action` sessionStorage for post-OAuth resume. `?as=X` URL param for partner-as switching across pp-bookings, pp-conversations, sidebar-badges |
| v73e | Bulletproof sign-out (waits for Clerk, clears sessionStorage, hard-redirect with cache-bust). Graceful "On request" fallback. New `price_indicator` field |
| v73d | Auth race fix: `openEnquiry()` wraps `tbAuth.requireUser()`. Robust async Clerk-user resolution. Empty "From" hidden when no price |
| v73c | Killed Step 3 of enquiry flow. Robust Clerk user resolution. Listing-page enquiry buttons redirect to property page. Inline error display. Pre-existing villas.html duplicate `.catch()` cleaned up |
| v73b | Property.html universal-template hardening: removed obsolete `kvHydrate()` IIFE, stashed URL slug as `window.PROPERTY_SLUG`, replaced fake conversation preview on Step 3 |
| v73a | Side-by-side Adults/Children number inputs. Fixed undefined `submitEnquiryAndGo()`. Cleaned orphaned SVG debris |
| v72z | **Critical fix: property.html had an unclosed `populateConfirmation()` function** that broke the entire page. Bug pre-dated v72y |
| v73f | Auth modal max-width 480→560 + remove Loading placeholder + clean-URL paths in stayInPlace. `tb_pending_action` sessionStorage for post-OAuth resume. `?as=X` URL param for partner-as switching across pp-bookings, pp-conversations, sidebar-badges |
| v73e | Bulletproof sign-out (waits for Clerk, clears sessionStorage, hard-redirect with cache-bust). Graceful "On request" fallback. New `price_indicator` field |
| v73d | Auth race fix: `openEnquiry()` wraps `tbAuth.requireUser()`. Robust async Clerk-user resolution. Empty "From" hidden when no price |
| v73c | Killed Step 3 of enquiry flow. Robust Clerk user resolution. Listing-page enquiry buttons redirect to property page. Inline error display. Pre-existing villas.html duplicate `.catch()` cleaned up |
| v73b | Property.html universal-template hardening: removed obsolete `kvHydrate()` IIFE, stashed URL slug as `window.PROPERTY_SLUG`, replaced fake conversation preview on Step 3 |
| v73a | Side-by-side Adults/Children number inputs. Fixed undefined `submitEnquiryAndGo()`. Cleaned orphaned SVG debris |
| v72z | **Critical fix: property.html had an unclosed `populateConfirmation()` function** that broke the entire page. Bug pre-dated v72y |
| v73e | Bulletproof sign-out (waits for Clerk to load, clears sessionStorage, hard-redirect with cache-bust). Graceful "On request" fallback for properties with no price. New `price_indicator` field on properties (free-text seasonal guidance, shown on booking sidebar) |
| v73d | Auth race fix: `openEnquiry()` wraps `tbAuth.requireUser()` like other Enquire buttons. Robust async Clerk-user resolution. Empty "From" hidden when no price |
| v73c | Killed Step 3 of enquiry flow. Robust Clerk user resolution. Listing-page enquiry buttons redirect to property page. Inline error display. Pre-existing villas.html duplicate `.catch()` cleaned up |
| v73b | Property.html universal-template hardening: removed obsolete `kvHydrate()` IIFE that hardcoded SLUG='nour-el-nil', stashed URL slug as `window.PROPERTY_SLUG`, replaced fake conversation preview on Step 3 |
| v73a | Side-by-side Adults/Children number inputs. Fixed undefined `submitEnquiryAndGo()`. Cleaned orphaned SVG debris |
| v72z | **Critical fix: property.html had an unclosed `populateConfirmation()` function** that broke the entire page. Bug pre-dated v72y |
| v73d | Auth race fix — `openEnquiry()` now wraps `tbAuth.requireUser()` like the other Enquire buttons (was a non-auth-gated shortcut). `submitEnquiryAndOpenChannel` async-loads Clerk if needed, opens sign-in modal on failure instead of dead-end error. Empty "From" price block hidden when property has no rooms |
| v73c | Killed Step 3 of enquiry flow. Robust Clerk user resolution. Listing-page enquiry buttons redirect to property page. Inline error display. Removed pre-existing duplicate `.catch()` in villas.html |
| v73b | Property.html universal-template hardening: removed obsolete `kvHydrate()` IIFE that hardcoded SLUG='nour-el-nil', stashed URL slug as `window.PROPERTY_SLUG`, replaced fake conversation preview on Step 3 |
| v73a | Replaced single Guests text field with side-by-side Adults/Children number inputs. Fixed undefined `submitEnquiryAndGo()` button. Cleaned orphaned SVG/`</a>` debris |
| v72z | **Critical fix: property.html had an unclosed `populateConfirmation()` function** that broke the entire page. Bug pre-dated v72y |
| v73c | Killed Step 3 of enquiry flow (Step 2 button now creates conversation and navigates directly). Robust Clerk user resolution. Listing-page enquiry buttons redirect to property page (no more fake "Enquiry sent" toast that does nothing). Inline error display. Removed pre-existing duplicate `.catch()` in villas.html |
| v73b | **Property.html universal-template hardening:** removed obsolete `kvHydrate()` IIFE that hardcoded SLUG='nour-el-nil', stashed URL slug as `window.PROPERTY_SLUG`, fixed populateConfirmation to use it, replaced fake iPhone conversation preview on Step 3 with clean confirmation panel |
| v73a | Replaced single text Guests field with side-by-side Adults/Children number inputs. Fixed "Open my conversation" button calling undefined `submitEnquiryAndGo()`. Cleaned orphaned SVG/`</a>` debris on Step 3 |
| v72z | **Critical fix: property.html had an unclosed `populateConfirmation()` function** that broke the entire page. Bug pre-dated v72y |
| v73b | **Property.html universal-template hardening:** removed obsolete `kvHydrate()` IIFE that hardcoded SLUG='nour-el-nil', stashed URL slug as `window.PROPERTY_SLUG`, fixed populateConfirmation to use it, replaced fake iPhone conversation preview on Step 3 with clean confirmation panel |
| v73a | Replaced single text Guests field with side-by-side Adults/Children number inputs. Fixed "Open my conversation" button calling undefined `submitEnquiryAndGo()`. Cleaned orphaned SVG/`</a>` debris on Step 3 |
| v72z | **Critical fix: property.html had an unclosed `populateConfirmation()` function** that broke the entire page. Bug pre-dated v72y |
| v72y | **Offer model + partner offer builder + pp-bookings rewritten with real data.** Worker: new `/api/offer` endpoint family (GET by id or bookingId, POST creates draft/sends immediately, PATCH for send/withdraw/edit-draft). Snapshots `commission_pct` into `commission_pct_at_time` at offer creation so future property edits don't alter sent offers. New KV: `offer:{id}`, `__offers_by_booking:{ref}`. Booking records gain `offers: []` + `active_offer_id` (on-read backfill). `/api/booking?slug=X` filter added. pp-bookings: dummy data deleted, real KV data, state-aware action buttons. Offer builder modal: trip dates auto-compute nights, pricing mode toggle, live deposit preview, repeatable inclusion items, exclusions, cancellation terms (required), notes, validity date. Save as draft OR send. Revisions auto-fill via `supersedes`. **Partner auth still hardcoded** (`PP_SLUG = 'nour-el-nil'`) — real multi-tenant partner auth deferred |
| v72x | **`commission_pct` + `booking_type` fields added to property schema.** Worker: `/api/property` GET backfills `commission_pct: null` and `booking_type: 'enquiry'` on legacy records (idempotent, in-memory). POST validates `commission_pct` is null or 1–25, `booking_type` must be `'enquiry'` (only valid v1 value). admin-property-editor: new "Section 0: Commercial terms" at top of Listing tab, marked Admin-only, with commission % input (inline validator with $5K example) and booking type select (instant-book reserved/disabled). admin-properties: each card shows commission pill — gray "15% commission" when set, amber "Commission not set" when null |
| v72w | **Stripe SDK scaffolding — connection ready, no flow yet.** New `package.json` with `stripe: ^17.0.0`. Stripe import in worker using `FetchHttpClient` (Workers don't have `node:https`). New `GET /api/stripe/health` (admin) + `POST /api/stripe/webhook` (signature-verified via `constructEventAsync` — sync `constructEvent` fails silently on Workers). `/api/health` extended with Stripe check. admin-settings System Health card shows Stripe row. admin-payments banner probes Stripe health on load and flips green/red/amber based on state. Required env vars: `STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY` in Cloudflare Pages (encrypted). `STRIPE_WEBHOOK_SECRET` not needed until v72z |
| v72v | **admin-payments dummy data killed + payments architecture locked.** Replaced hardcoded $2.41M GMV / $361k commission / fake transactions / fake disputes with honest empty state. Status banner, em-dash KPI tiles, empty transactions card, roadmap panel. **Booking model decisions locked (apply to all subsequent payment builds):** (1) **Deposit-only model** — TheBearing collects only its negotiated commission percentage as non-refundable booking fee. Partner arranges balance directly with member. (2) **All USD** — partners enter USD; member pays USD; no FX risk in TheBearing data model. (3) **Per-property `commission_pct`** — variable per property (UI in v72x). (4) **Enquiry-only booking flow for v1** — no instant-book / channel-manager integrations until partner-specific need. (5) **Pricing supports both per-night × nights AND package total** — partner chooses per offer. Single nightly rate, no mid-stay changes for v1. (6) **Offer revisions, not counter-offers** — partner builds a new offer that supersedes the previous one |
| v72u | **Removed misplaced "Property partner? Sign in" link from customer footer on 6 customer pages** (lens, saved, bookings, preferences, settings, search). Dark footer bar stays — only the partner link was removed |
| v72t | **View transitions extended to partner + customer portals.** Renamed `admin-chrome.css` → `portal-chrome.css` with portal-agnostic transition name. Linked from 33 portal pages (11 admin + 13 partner + 9 customer). 245 internal portal hrefs cleaned of `.html`. Badge scripts updated to match both URL forms |
| v72s | **Found the actual root cause of the navigation flash: redirect-skip.** Cloudflare Pages canonicalizes URLs by redirecting `/admin-foo.html` → `/admin-foo` (clean URL). Cross-document view transitions are explicitly skipped by browsers when a navigation involves a redirect. Fix: stripped `.html` from all 22 internal admin links so navigations go straight to the canonical URL with no redirect hop. Also bumped `SIDEBAR_VERSION` to 2 in `admin-sidebar-inject.js` so existing browsers don't serve the old cached sidebar with the `.html` links |
| v72p | **Conversation scroll-to-bottom fix across admin / customer / partner portals.** New shared helper `assets/conv-scroll.js` exposes `window.pinToBottom(wrap, opts)` — uses `scrollIntoView({block:'end'})` on the last child, repeats across 3 animation frames to catch late reflows, attaches a 1-second ResizeObserver so image-load / reaction-render reflows re-pin. Applied at all 6 sites: open-conv + polling-refresh in admin-conversations.html / conversations.html / pp-conversations.html |
| v72o | **admin-properties.html: dead prospecting code removed + listing-order regression fix.** The AI prospecting kanban (kanban + AI email composer + Resend send + template gallery + reply tracker) was already non-functional. Removed ~470 lines of JS, 4 dead modals, unused CSS. File shrunk 1281 → 786 lines. Also fixed v72m regression: worker now special-cases `__index_hotels`/`__index_cruises`/`__index_villas` writes so the Listing Order save button works again |
| v72n | **Admin sidebar consolidated to a cached partial — no more flash on nav.** Extracted sidebar HTML to `assets/admin-sidebar.html`. New `assets/admin-sidebar-inject.js` reads `sessionStorage['tb_admin_sidebar_v1']` and injects synchronously on cache hits. First-ever load this session fetches the partial once (~40ms), caches it, and re-runs the badge + user-name hooks. Every admin page now has `<body data-page="X">` so inject script can mark the right link active. Net: −40kB across the 11 admin pages, no flash on subsequent nav. Bump `SIDEBAR_VERSION` in inject.js when changing the partial |
| v72m | **Property index hygiene + slug validation.** Three garbage slugs were showing up in admin-analytics' Live Listing Health: `__index_villas`, `__index_hotels`, `__index_cruises` (curated-order metadata keys that got POSTed as property records in an early version of the reorder feature) plus `singita-grumeti-x` (empty stub record). **Fixes:** worker GET defensively filters `__*` slugs; POST validates slug format strictly; new `POST /api/property/cleanup` endpoint; admin-settings.html has a "Maintenance" section with a "Clean property index" button; admin-analytics double-filters client-side |
| v72l | **admin-analytics.html rebuilt from scratch — zero dummy data.** All hardcoded values gone (`$2.41M`, `$612k`, fake top-properties list, traffic-sources guesses, conversion-funnel made-up rates, fake member-growth chart). New layout reads exclusively from `/api/members`, `/api/booking`, `/api/conversation`, `/api/property`. Sections: (1) KPIs — Members / Enquiries / Confirmed bookings / GMV, all period-filtered; (2) Activity over time — 3-series SVG line chart with member/enquiry/booking buckets by day/week/month based on period; (3) Top properties by enquiry volume — sorted, with bookings + GMV per row; (4) Booking pipeline — confirmed/pending/cancelled split with value sums; (5) Member sign-in providers — Google/Apple/Email breakdown with bars; (6) Enquiry response performance — total / replied / awaiting / avg-wait / longest-waiting with color thresholds; (7) Live listing health — preserved KV completeness scorer. Date tabs (7d/30d/90d/12m/All) now actually filter. CSV export works — produces multi-section CSV (Members, Enquiries, Bookings) with KV data, filtered to current period. Honest empty states everywhere — "No enquiries in last 30 days yet." rather than synthesised numbers |
| v72k | Stale-conversation cron diagnostics + manual trigger. **Symptom:** Cloudflare Cron events showed 12+ successful hourly runs but the System Health card stayed "no runs recorded." **Root cause:** the cron's early-return guard `if (!env.DOSSIERS || !env.RESEND_API_KEY) return` exited before reaching the `__cron:last_run` KV write — so successful-but-skipped runs were invisible. Suggests `RESEND_API_KEY` may not be injected into the scheduled() handler even when bound to the request handler (known Pages Functions quirk). **Fix:** (a) cron now writes `__cron:last_run` on every run including skips, with a `skipped` reason field; (b) new endpoint `POST /api/cron/run` (admin-gated) triggers the cron synchronously and returns the run summary; (c) admin-settings.html System Health card has a "Run now" button on the cron row that fires the manual trigger and refreshes the row. Health card cron detail now distinguishes "skipped" / "errored" / "last ran X" |
| v72j | Admin auth fix for multi-email Clerk accounts. **Root cause:** Miguel's Clerk account has `mcancino@gmail.com` as primary email and `admin@thebearing.io` as a secondary. `admin-gate.js` was iterating all linked emails so the client gate accepted him, but `admin-fetch.js` was only sending the primary email in `X-Admin-Email` — so the worker saw `mcancino@gmail.com`, found it not in the allowlist, and 403'd. **Fix:** `admin-fetch.js` now sends ALL of the user's emails as a comma-separated `X-Admin-Email` header. Worker Path 2 splits on commas and accepts if any candidate is in the allowlist. Confirmed via worker log line `[Admin] Email header path: not in allowlist. email= mcancino@gmail.com allowlist= admin@thebearing.io` after v72i's diagnostic logging |
| v72i | Admin auth hardening: `isAdmin()` no longer returns `false` outright when Path 1 (Clerk session verify) attempts and fails — it now always falls through to Path 2 (X-Admin-Email header check) as a fallback. Previously, an attempted-but-failed Clerk verify (e.g. session token format mismatch, transient Clerk API error) returned false immediately, even when a valid X-Admin-Email header was present, causing 403s on `/api/settings` and `/api/health`. Added diagnostic console.log lines on every failure branch so Cloudflare Pages worker logs show exactly which path failed and why |
| v72h | Email policy update: `admin@thebearing.io` is the only address in use. Notification baseline `BASELINE_NOTIFICATION_RECIPIENT` in worker switched from `miguel@thebearing.io` → `admin@thebearing.io`. admin-settings.html help text updated. admin-properties.html: prospecting-email signature address and "From email" placeholder both updated to `admin@thebearing.io`. v72g build-history row left as-is (historical record). HANDOFF booking-system note updated to reflect new baseline |
| v72g | **admin-settings.html built out.** Three sections: (1) Notification recipients — chip-list editor, baseline `miguel@thebearing.io` locked & always included; (2) Admin allowlist — chip-list editor, baseline `admin@thebearing.io` locked; (3) System health — live checks for KV, Resend (validates API key via `/domains`), Vectorize (`describe()`), Workers AI, Anthropic, Clerk, and cron last-run. Worker: `__settings:notifications` and `__settings:allowlist` KV-backed; 5 hardcoded `to:['miguel@thebearing.io']` recipients refactored to `loadNotificationRecipients()`; `ADMIN_EMAILS` refactored to `getAllowlist()` merging baseline + KV extras. New endpoints: `/api/settings` (GET/POST admin-gated), `/api/settings/allowlist-public` (GET unauth — used by client gate), `/api/health` (GET admin-gated). `assets/admin-gate.js` extended to fetch dynamic allowlist on every admin page load, 3s cap, baseline-only on failure. Cron persists `__cron:last_run` with `{ranAt, durationMs, scanned, sent, ok}` for the health check |
| v72f | (build packaged but history row not recorded — inherited zip from previous session)  |
| v72e | Envoy drawer positioning fix: lens/saved/bookings/preferences had dark-theme styling but were missing `position:fixed; right:0; width:25vw; transform:translateX(100%)` base rules — drawer rendered without positioning, breaking layout. Patched all 4 pages with full positioning + open-state + body-push + responsive rules |
| v72d | Conversation pages dead-space fix at bottom of viewport: customer (`account-wrap` padding-top + height calc overflowed by 66px → set `height:100dvh; box-sizing:border-box`), admin (was subtracting 60px for a topbar that doesn't exist → `height:100vh`), partner (`calc(100vh - 200px)` over-budgeted → `flex:1; min-height:0`) |
| v72c | property.html hardening: 12s safety timeout, granular error messages instead of generic, console diagnostics, isolated renderProperty try/catch, loadSimilar chained as `.catch()` so it can't block main render. Fixed `/property?slug=` (no .html) in similar cards + admin-property-editor preview button |
| v72b | Customer page "View property" action: special-cases `nour-el-nil` slug → `/nour-el-nil.html` (dedicated hand-built page), all other slugs → dynamic `/property.html?slug=...` template |
| v72 | Customer conversations full visual parity: 3-column layout (responsive, collapses <1100px), property details panel (hero image, facts, your enquiry, View property + Save to wishlist), Clerk photo for guest avatars, role-distinct bubbles, hover actions, reactions (guest scoped), sound (`tb_guest_sound`), animations, day separators, ⌘+Enter to send |
| v71 | Partner portal conversations parity: 3-column with partner-scoped guest context panel (no LTV/notes/saved-replies — admin only). Previous conversations filtered to `propertySlug === PP_SLUG` (privacy). Sound key `tb_pp_sound` |
| v70g | Emoji popover diagonal-mouse fix: popover centered above smiley btn, invisible bridge below popover, `.actions-pinned` class on parent action bar via JS + CSS `:has()` so the action bar stays visible while picker open |
| v70f | Session 3 admin polish: emoji reactions (6 emoji, per-message KV via `action:'reaction'`), saved replies (`/api/saved-replies` GET/POST/DELETE admin-gated, stored at `__saved_replies`), sound on incoming msgs (Web Audio chirp, `tb_admin_sound`), message fade-in animation, click-outside closes popovers |
| v70e | Session 2 admin polish: right-side guest context panel (avatar, presence, stats grid Joined/Convs/Bookings/LTV, Tier/Location/Provider, Other conversations, Internal notes with 800ms autosave). Hover actions on messages (emoji react / reply-quote / copy with toast confirmation). Quoted reply prepends `> Sender wrote:` in send |
| v70d | (folded into v70e) |
| v70c | (folded into v70e) |
| v70b | Session 1 admin conversation redesign: 3-column layout (340 + flex + 320), grouped time buckets (Today/Yesterday/This week/Older), unread+wait-time pills, polished thread header (avatar+name+sub+actions), day separators, avatar grouping (3+ msgs in 5min stack visually), role-distinct bubbles, viewer-relative positioning, composer with auto-resize + ⌘+Enter |
| v70 | admin-guests polish: search box (name/email/location/tier/notes), filter tabs (All/Founding/Active/New), sortable columns, default sort newest joined desc, Provider as Google/Apple/Email text, removed unused Credits column, XSS-safe |
| v69c | admin-bookings: GMV stat fixed (exclude cancelled, use totalAmount), Value column shows total + deposit ("$8,400 / $2,100 dep."), distinct empty states, auto-refresh 30s when visible |
| v69b | admin-bookings polish: real-time search across ref/name/email/property/room/notes, sortable columns (Reference/Arrival/Value) with arrow indicators, default sort newest createdAt desc |
| v69 | Admin stub cleanup: deleted admin-conversation.html, admin-property-detail.html, admin-booking-detail.html, admin-content.html, admin-invite.html. Sidebar scrubbed across all admin pages. Worker email templates updated to `admin-conversations.html` |
| v68f | Auth gating polish: admin-login.html shows yellow banner + sign-out option for already-signed-in non-admins (doesn't auto-mount Clerk widget or sign them out). SPA fallback removed (`not_found_handling: "404-page"`) |
| v68 | Admin auth gating: `assets/admin-gate.js` client gate (waits for `Clerk.loaded===true`, hides body until verified, redirects non-admins to `/admin-login.html`), worker `isAdmin()` server gate on POST/DELETE `/api/property`, `assets/admin-fetch.js` wraps fetch to attach X-Admin-Email/X-Clerk-Session. Allowlist: `admin@thebearing.io` (hardcoded in 3 places — keep in sync). Clerk allows 2nd email per account |
| v67 | Stale conversation reminder cron: hourly `0 * * * *` in wrangler.toml `[triggers] crons`. Worker `runStaleConvReminders()` scans `unreadAdmin>0 && !archived`, escalates 24h→partner, 48h→partner+admin, 72h→urgent both. Tracks `conv.reminders.{sent24At,sent48At,sent72At}`, resets on reply. Admin UI shows colored pill in thread header ("24h reminder sent" amber → 48h orange → 72h red) |
| v66h | Admin dashboard rewrite: removed deprecated Property pipeline card. Real Live Activity card (new enquiries, replies, bookings, member signups — clickable). Real Conversations needing attention (sorted oldest first, dynamic wait time, red ≥4d, amber ≥1d, "Step in" button). Recent bookings table reads `/api/booking`. Auto-refresh 30s when tab visible |
| v66 | Foundation period: pre-redesign housekeeping (admin sidebar consistency, status badge polish, various stub pages cleanup) |
| v65 | Cron infrastructure added: wrangler `[triggers] crons` + `scheduled()` handler scaffolding |
| v64 | Resend inbound webhook: `/api/inbound-email` handler. Resend `email.received` has NO body — must fetch via `/emails/receiving/{id}` |
| v63 | Notification toggles `notifyAdmin`/`notifyPartner`/`notifyGuest` on conversations; `/api/notify-toggle` endpoint |
| v62 | Conversation system maturation: presence (`/api/presence` + `conv-presence.js` heartbeat/visible/favicon-dot), unread counters recomputed, archive status |
| v61 | Clerk authentication integrated for admin login; `/api/members` member tracking, `/api/clerk-webhook` for sign-up events |
| v60 | Admin listing order tab: drag-to-reorder with `__index_cruises`/`__index_hotels`/`__index_villas` curated arrays; `toast()` UI helper added |
| v59 | Dynamic KV loaders for cruises/hotels/villas: curated index controls featured order, unmatched items appended after |
| v58 | Envoy L1-L3 work: page-aware dossier+sources injection, structured dossier admin authoring, AI-assisted dossier draft with web search. L4 Vectorize blocked. `CI_SYSTEM` prompt fragmentation documented in `docs/ENVOY_PROMPT_EXTRACTION_DOSSIER.md` for future extraction to `assets/envoy-prompt.js` |
| v57j | Cruises header: CF image `2d9c0e5f` set as hero, object-position bottom 2/3 |
| v57i | Cruises header: updated to CF image URL |
| v57h | Cruises header: full-bleed cinematic dark (Option A) applied |
| v57g | Cruises header: Option C (photo strip + text bar) applied |
| v57f | Cruises: removed 3 demo voyage cards (Aqua Nera, Four Seasons, Silver Origin) |
| v57e | Listing loaders: fixed hasCurated scope + removed double-fetch |
| v57d | Listing loaders: fixed isCruise filter blocking curated properties |
| v57c | toast() added to admin; cruises/hotels/villas loaders respect curated order fully |
| v57b | Villas dynamic loader added; all 3 listing pages have KV loaders |
| v57 | All 35 pages clean audit; NEN image URLs replaced; cruises KV loader added |
| v56f | property.html: dual Book now + Enquire buttons added |
| v56e | Vibe search: frosted glass suggestion pills |
| v56d | Mobile slide-up drawers for booking + enquiry on all pages |
| v56c | Book bar: dual buttons on all 13 property pages |
| v56b | Mobile overlays: X button + bottom sheet CSS on all pages |
| v56 | 12 property pages fully rebuilt from nour-el-nil template |

---
*Update this file every time a new build is pushed to GitHub.*
