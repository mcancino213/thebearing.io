# Sitewide Button & Link Audit — v76q (2026-10-04)

**Trigger:** the "Start your inquiry — no commitment" button on property.html was dead; Miguel asked for a comprehensive audit of every button on every page.

**Method:** `docs/audit_buttons.py` — for every HTML page, extracts every `onclick/onsubmit/onchange/onkeydown/oninput` handler and verifies each invoked function is defined on that page (inline scripts + the shared assets that page actually loads); checks every internal `href` against files that exist. Re-run it after any build that touches handlers. Supplemented by per-script `node --check` with **no error classes skipped** (see policy change below) and real raw-coordinate click-throughs in Playwright.

## Findings & resolutions

| # | Where | Finding | Resolution |
|---|-------|---------|-----------|
| 1 | property.html | Promise-panel button called `tbAuthEnquire()` — defined only on nour-el-nil.html → ReferenceError, dead | → `openEnquiry()` (the page's own auth-gated flow, same as its sibling buttons) |
| 2 | nour-el-nil.html | **The entire 3-step enquiry block was parse-dead**: a closing brace on `populateConfirmation` was lost in a ~v75u edit → `goStep`, the stepper, and enquiry submit were all undefined. `submitEnquiryAndGo` was a symptom, not the cause. **Flagship step-enquiries were likely broken in production since ~v75u.** | Brace restored; block parses; `goStep`/`populateConfirmation` live again. Dead `submitEnquiryAndGo()` onclick → `goStep(3)` |
| 3 | nour-el-nil.html | `expandPhoto(0–5)` on all six mosaic photos — never defined | Minimal lightbox implemented (overlay, prev/next, Esc) |
| 4 | index, collections, search, the-bearing | `submitQuickEnquiry()` was **FAKE** — closed the modal and toasted "Enquiry sent — the property will reply within 24 hours" **without sending anything** | Fake removed. `openQuickEnquiry` on all 7 pages now deep-links to the property page's REAL auth-gated enquiry (`?enquire=1` auto-open; flagship → `/nour-el-nil.html?enquire=1`) |
| 5 | cruises, hotels, villas | `submitQuickEnquiry()` undefined (modal could open, submit dead) | Superseded by the same convergence (modal no longer opens; inert markup kept; safe stub defined) |
| 6 | settings.html | Mobile-menu "The Envoy" called `openEnvoy()` with no drawer on the page | v76j shared drawer module mounted (button works + page gains the Envoy) |
| 7 | admin-property-editor.html | `toggleSection(this)` on every section header — never defined | Defined + `.collapsed` CSS |
| 8 | All pages | Internal hrefs → nonexistent files | **Zero** (v76p already cleaned) |

## Policy change (logged in HANDOFF)
Per-script `node --check` sweeps previously **skipped "Unexpected end of input"** as template-literal noise — that skip masked finding #2 for weeks. Sweeps now report every failure; the sitewide unexpected-end inventory must be **zero** (it is, as of v76q).

## Verified by real interaction (Playwright, raw mouse coordinates, stubbed KV)
- hotels "Enquire first" → lands `/property.html?slug=…&enquire=1` → real enquiry opens, pending-action stashed, zero errors
- property promise button → `openEnquiry()` runs, pending-action stashed, zero errors (a "covered by nav" reading was a thin-stub artifact: short test page couldn't center-scroll; full-length real page unaffected)
- flagship: `goStep`/`populateConfirmation` restored to functions, lightbox opens, zero page errors
