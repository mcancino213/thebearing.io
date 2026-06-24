// customer-fetch.js — wraps window.fetch to attach the Clerk session JWT on
// same-origin /api/* calls from customer-facing pages. Mirrors
// assets/partner-fetch.js (partner portal) and assets/admin-fetch.js (admin).
//
// v75i: completes the data-layer security started in v75f/v75g. The partner
// endpoints (?slug=) are locked; this wrapper lets the customer-scoped
// endpoints (?email=, ?ref=, ?id=, ?guestId=) be locked too, by ensuring
// customer pages send a verifiable identity token. The worker verifies the
// JWT and confirms the requester is the guest they claim to be.
//
// IMPORTANT — safe on public pages:
//   nour-el-nil.html and property.html are shown to signed-OUT visitors.
//   This wrapper only ADDS a header when a Clerk session exists. Signed-out
//   visitors get no header (and those pages only call personal-data
//   endpoints when a user is signed in anyway). So adding this script to a
//   public page does not break anonymous browsing.
//
// Behavior:
//   - Only intercepts same-origin '/api/*' requests; everything else passes
//     through untouched (including Clerk's own SDK calls to its domain).
//   - Waits for Clerk readiness (cap 8s) before forwarding /api/* calls so a
//     page-load fetch doesn't race ahead of Clerk and miss the token.
//   - If no session (signed-out), forwards WITHOUT the header — the worker
//     treats it as unauthenticated. For public reads that's fine; for
//     personal-data endpoints the worker returns 403, which the page's
//     existing .catch / r.ok checks already handle by showing empty data.
//   - Never overwrites an X-Clerk-Session header a caller set explicitly.
(function() {
  if (window.__tbCustomerFetchInstalled) return;
  window.__tbCustomerFetchInstalled = true;

  var originalFetch = window.fetch.bind(window);

  function isApiRequest(input) {
    try {
      var u;
      if (typeof input === 'string') {
        if (input.indexOf('/api/') === 0) return true;
        u = new URL(input, location.href);
      } else if (input && input.url) {
        u = new URL(input.url, location.href);
      } else {
        return false;
      }
      return u.origin === location.origin && u.pathname.indexOf('/api/') === 0;
    } catch(e) {
      return false;
    }
  }

  async function getSessionToken() {
    try {
      if (window.Clerk && window.Clerk.session && typeof window.Clerk.session.getToken === 'function') {
        return await window.Clerk.session.getToken();
      }
    } catch(e) {
      // No session / not signed in — return null, request goes out unauthenticated
    }
    return null;
  }

  // Wait until Clerk is ready (loaded === true), capped at maxMs. Resolves
  // either way. On public pages (property.html, nour-el-nil.html) Clerk is
  // loaded lazily by auth.js only when the user interacts with sign-in — so
  // if window.Clerk doesn't exist yet, we DON'T wait (no point stalling a
  // public read for 8s waiting for an SDK that won't load). We only wait when
  // Clerk exists but hasn't finished loading (a real race worth waiting out).
  function awaitClerk(maxMs) {
    return new Promise(function(resolve) {
      if (!window.Clerk) { resolve(); return; }              // SDK not present — don't wait
      if (window.Clerk.loaded === true) { resolve(); return; } // already ready
      var deadline = Date.now() + (maxMs || 8000);
      var t = setInterval(function() {
        if (!window.Clerk) { clearInterval(t); resolve(); return; }
        if (window.Clerk.loaded === true) { clearInterval(t); resolve(); return; }
        if (Date.now() > deadline) { clearInterval(t); resolve(); return; }
      }, 80);
    });
  }

  window.fetch = async function(input, init) {
    if (!isApiRequest(input)) {
      return originalFetch(input, init);
    }
    init = init || {};
    var headers = new Headers(init.headers || {});
    if (!headers.has('X-Clerk-Session')) {
      await awaitClerk(8000);
      var token = await getSessionToken();
      if (token) headers.set('X-Clerk-Session', token);
    }
    init.headers = headers;
    return originalFetch(input, init);
  };
})();
