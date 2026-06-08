// partner-gate.js — runs on every /pp-*.html page except pp-login.html.
// Verifies a signed-in Clerk user is present. Signed-out visitors are
// redirected to /pp-login. Mirrors assets/admin-gate.js pattern.
//
// v75e: closes the security gap flagged in v74x, v75, v75c. Before this,
// any URL-knowing visitor could navigate directly to /pp-dashboard,
// /pp-bookings, /pp-conversations etc. and see partner data without
// signing in. Even after sign-out (which clears the Clerk session and
// the local cache), the partner pages would still render — they were
// rendering page chrome from HTML + populating from cached/empty data.
//
// What this gate does and does NOT do:
//   - DOES: stop signed-out browsers from rendering partner pages
//   - DOES NOT: prevent a determined attacker from disabling JS or
//     stripping the gate script. The /api/booking, /api/conversation
//     endpoints currently return data without user-level auth — that's
//     the v75f hardening pass that follows this build.
//
// Gate flow:
//   1. Load Clerk SDK (inline script tag in each partner page's <head>)
//   2. This script runs, hides body via inline <style>
//   3. Wait for Clerk to finish loading (cap 15s)
//   4. If Clerk.user present → reveal body, attach sign-out listener
//   5. If Clerk.user absent → redirect to /pp-login
//
// Body-hide is skipped on subsequent partner-portal navigations (same
// session) to allow view transitions to animate. Same trick as admin-gate.
(function() {
  var AUTH_FLAG = 'tb_pp_verified_v1';

  // First-load-this-session: hide body until verified. Subsequent loads
  // skip the hide so cross-document view transitions can animate.
  // If the session got revoked between navs, evaluate() catches it and
  // still redirects — we just briefly show content before the redirect
  // fires, which is acceptable because the data endpoints are still
  // server-checked (in v75f) and Clerk's session cookie is the truth.
  var alreadyVerified = false;
  try { alreadyVerified = sessionStorage.getItem(AUTH_FLAG) === '1'; } catch(e) {}

  if (!alreadyVerified) {
    var hideStyle = document.createElement('style');
    hideStyle.id = 'pp-gate-hide';
    hideStyle.textContent = 'body{visibility:hidden!important;}';
    (document.head || document.documentElement).appendChild(hideStyle);
  }

  function reveal() {
    var s = document.getElementById('pp-gate-hide');
    if (s) s.remove();
    try { sessionStorage.setItem(AUTH_FLAG, '1'); } catch(e) {}
  }

  function denied(reason) {
    try { sessionStorage.removeItem(AUTH_FLAG); } catch(e) {}
    // Clear partner-portal local state too — same cleanup as pp-settings
    // sign-out, so a signed-out user doesn't leave stale identity behind.
    try {
      sessionStorage.removeItem('tb_pp_sidebar_v1');
      sessionStorage.removeItem('tb_pp_sidebar_v2');
      sessionStorage.removeItem('tb_pp_sidebar_v3');
      sessionStorage.removeItem('tb_pp_user_cache');
    } catch(e) {}
    try { sessionStorage.setItem('tb_pp_denied_reason', reason || 'not_signed_in'); } catch(e) {}
    // Use replace() so the back button doesn't return to the gated page.
    window.location.replace('/pp-login');
  }

  // Wait for Clerk to be fully loaded. Clerk sets `loaded = true` only
  // after Clerk.load() resolves. addListener existing is NOT sufficient.
  function waitForClerkReady(maxMs, cb) {
    var startedAt = Date.now();
    var t = setInterval(function() {
      if (window.Clerk && window.Clerk.loaded === true) {
        clearInterval(t);
        cb(null);
        return;
      }
      if (Date.now() - startedAt > maxMs) {
        clearInterval(t);
        cb(new Error('clerk_timeout'));
      }
    }, 150);
  }

  // v75e: also writes the tb_pp_user_cache here so any page is safe to
  // navigate to directly (not just from pp-login). Mirrors the cache
  // helper in pp-login.html but centralized here so all partner pages
  // share the same cache-keeping logic.
  function cacheUser(user) {
    if (!user) return;
    try {
      var name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
      var email = user.primaryEmailAddress ? user.primaryEmailAddress.emailAddress : '';
      if (!name && email) name = email.split('@')[0];
      var initials = name.split(/\s+/).map(function(w){return (w[0]||'').toUpperCase();}).join('').slice(0,2) || '?';
      sessionStorage.setItem('tb_pp_user_cache', JSON.stringify({
        id: user.id || '',
        name: name || '',
        email: email || '',
        avatarUrl: user.imageUrl || '',
        initials: initials,
        signedInAt: new Date().toISOString(),
      }));
    } catch(e) {}
  }

  function evaluate() {
    var user = window.Clerk && window.Clerk.user;
    if (!user) {
      denied('not_signed_in');
      return;
    }
    // Authorized — refresh the cache so the sidebar/header have current data
    cacheUser(user);
    reveal();
    // Watch for sign-out fired from another tab or via Clerk.signOut() on
    // this page (pp-settings does this). If the user becomes null, kick to
    // login.
    try {
      window.Clerk.addListener(function(resources) {
        if (!resources.user) {
          denied('signed_out');
        }
      });
    } catch(e) {}
  }

  function start() {
    waitForClerkReady(15000, function(err) {
      if (err) {
        denied('clerk_timeout');
        return;
      }
      evaluate();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
