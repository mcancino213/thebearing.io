// partner-fetch.js — wraps window.fetch to attach X-Clerk-Session on /api/*
// requests from partner pages. Mirrors assets/admin-fetch.js for admin.
//
// v75f: closes the data-layer security gap left open by v75e. The partner
// auth gate hides page chrome from signed-out browsers, but the underlying
// API endpoints (/api/booking, /api/conversation, etc.) had no per-user
// authorization. With this wrapper, every partner-portal API call carries
// the Clerk session token, the worker verifies it, and only returns data
// the user is authorized to see.
//
// Behavior:
//   - Wraps fetch() — only intercepts URLs starting with '/api/' or with
//     the same origin's '/api/' path. Other fetches pass through unchanged.
//   - For /api/* calls, AWAITS Clerk readiness before letting the request
//     fly. Without this wait, page-load fetches race ahead of Clerk loading
//     and go out unauthenticated → 403. Cap the wait at 8 seconds; after
//     that we let the request go (without the header) so we get a clean
//     403 the calling code can handle, rather than hanging forever.
//   - Reads Clerk session id from window.Clerk.session.id once Clerk is
//     ready.
//   - Does NOT remove existing X-Clerk-Session headers if the caller set
//     one explicitly.
(function() {
  if (window.__tbPartnerFetchInstalled) return;
  window.__tbPartnerFetchInstalled = true;

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

  function getSessionId() {
    try {
      return (window.Clerk && window.Clerk.session && window.Clerk.session.id) || null;
    } catch(e) { return null; }
  }

  // v75g: get the session JWT (not the session id). The worker verifies this
  // JWT's signature and reads the `sub` claim for the user id. getToken() is
  // async and returns a fresh, short-lived JWT. Returns null if no session.
  async function getSessionToken() {
    try {
      if (window.Clerk && window.Clerk.session && typeof window.Clerk.session.getToken === 'function') {
        return await window.Clerk.session.getToken();
      }
    } catch(e) {
      console.log('[partner-fetch] getToken failed:', e.message);
    }
    return null;
  }

  // Wait until Clerk is ready (loaded === true), capped at 8s. Resolves
  // either way — the caller checks for a token after.
  function awaitClerk(maxMs) {
    return new Promise(function(resolve) {
      if (window.Clerk && window.Clerk.loaded === true) { resolve(); return; }
      var deadline = Date.now() + (maxMs || 8000);
      var t = setInterval(function() {
        if (window.Clerk && window.Clerk.loaded === true) {
          clearInterval(t); resolve(); return;
        }
        if (Date.now() > deadline) {
          clearInterval(t); resolve(); return;
        }
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
