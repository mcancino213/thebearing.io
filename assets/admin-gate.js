// admin-gate.js — runs on every /admin-*.html page (except admin-login.html)
// Verifies the signed-in Clerk user is on the admin allowlist.
// Non-admins are redirected to /admin-login.html with a clear message.
//
// Allowlist sources:
//   1. BASELINE — hardcoded founder address (always allowed; this is the failsafe
//      so the founder can never be locked out by a bad settings edit).
//   2. /api/settings/allowlist-public — public read of extras added via
//      admin-settings.html. Fetched on every admin page load in parallel with
//      Clerk init. If the fetch fails, only the baseline is honoured.
(function() {
  var ADMIN_EMAILS = ['admin@thebearing.io'];
  var AUTH_FLAG = 'tb_admin_verified_v1';

  // Hide page contents until auth check completes — but ONLY on the first
  // admin page load this session. On subsequent navigations within the admin
  // portal (every sidebar click), we skip the hide so cross-document view
  // transitions can actually animate between the two pages. The browser was
  // showing white between every navigation because the destination page was
  // hidden by this script the moment it began loading.
  //
  // Security note: the worker independently verifies admin status on every
  // API call regardless of what the client renders, so a brief moment of
  // visible content during the background re-check on subsequent loads
  // doesn't leak anything. Clerk's session cookie is still valid across the
  // navigation; we're just trusting that the auth we verified <1s ago is
  // still valid for the next click. If the session genuinely expired, the
  // re-check fails and the redirect to /admin-login.html still happens.
  var alreadyVerified = false;
  try { alreadyVerified = sessionStorage.getItem(AUTH_FLAG) === '1'; } catch(e) {}

  if (!alreadyVerified) {
    var hideStyle = document.createElement('style');
    hideStyle.id = 'admin-gate-hide';
    hideStyle.textContent = 'body{visibility:hidden!important;}';
    (document.head || document.documentElement).appendChild(hideStyle);
  }

  function reveal() {
    var s = document.getElementById('admin-gate-hide');
    if (s) s.remove();
    // Mark the session as verified so subsequent navigations don't hide.
    try { sessionStorage.setItem(AUTH_FLAG, '1'); } catch(e) {}
  }

  function denied(reason) {
    // Clear the verified flag — whatever state got us here, we no longer
    // trust it for future loads in this tab.
    try { sessionStorage.removeItem(AUTH_FLAG); } catch(e) {}
    sessionStorage.setItem('tb_admin_denied_reason', reason || 'not_authorized');
    window.location.replace('/admin-login.html');
  }

  // Fetch dynamic extras from the worker; fail-soft if unreachable.
  // Kicked off immediately so it can run in parallel with Clerk.load().
  var allowlistPromise = fetch('/api/settings/allowlist-public', { cache: 'no-store' })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(j) {
      if (j && Array.isArray(j.allowlist)) {
        j.allowlist.forEach(function(em) {
          var lc = String(em || '').toLowerCase().trim();
          if (lc && ADMIN_EMAILS.indexOf(lc) === -1) ADMIN_EMAILS.push(lc);
        });
      }
    })
    .catch(function() { /* baseline-only fallback */ });

  function isAdmin(user) {
    if (!user) return false;
    var emails = [];
    if (user.primaryEmailAddress && user.primaryEmailAddress.emailAddress) {
      emails.push(user.primaryEmailAddress.emailAddress);
    }
    if (Array.isArray(user.emailAddresses)) {
      user.emailAddresses.forEach(function(e) {
        if (e.emailAddress) emails.push(e.emailAddress);
      });
    }
    return emails.some(function(em) {
      return ADMIN_EMAILS.indexOf(em.toLowerCase()) !== -1;
    });
  }

  // Wait for Clerk to be FULLY loaded, not just for addListener to exist.
  // Clerk sets `loaded` to true only after `Clerk.load()` resolves.
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

  function evaluate() {
    var user = window.Clerk && window.Clerk.user;
    if (!user) {
      denied('not_signed_in');
      return;
    }
    if (!isAdmin(user)) {
      denied('not_authorized');
      return;
    }
    // Authorized
    reveal();
    // Watch for sign-out/changes
    window.Clerk.addListener(function(resources) {
      if (!resources.user || !isAdmin(resources.user)) {
        denied('signed_out');
      }
    });
  }

  function start() {
    waitForClerkReady(15000, function(err) {
      if (err) {
        denied('clerk_timeout');
        return;
      }
      // Make sure the allowlist fetch has settled (success or failure) before
      // evaluating. allowlistPromise never rejects — failures fall through to
      // baseline-only. We cap the wait at ~3s to avoid blocking forever on a
      // network issue; baseline-only is a reasonable failure mode.
      var settled = false;
      var capT = setTimeout(function() { if (!settled) { settled = true; evaluate(); } }, 3000);
      allowlistPromise.then(function() {
        if (settled) return;
        settled = true; clearTimeout(capT); evaluate();
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
