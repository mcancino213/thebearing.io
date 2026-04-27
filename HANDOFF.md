# TheBearing.io — Handoff Document
> Last updated: 2026-04-27 | Current build: v57j

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
