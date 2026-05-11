// admin-gate.js — runs on every /admin-*.html page (except admin-login.html)
// Verifies the signed-in Clerk user is on the admin allowlist.
// Non-admins are redirected to /admin-login.html with a clear message.
//
// This is FRONTEND-ONLY enforcement — the real security comes from the server
// also rejecting admin API operations from non-admin users. See worker /api/admin-check.
(function() {
  var ADMIN_EMAILS = ['admin@thebearing.io'];

  // Hide page contents instantly to prevent flash of admin UI before redirect
  var hideStyle = document.createElement('style');
  hideStyle.id = 'admin-gate-hide';
  hideStyle.textContent = 'body{visibility:hidden!important;}';
  (document.head || document.documentElement).appendChild(hideStyle);

  function reveal() {
    var s = document.getElementById('admin-gate-hide');
    if (s) s.remove();
  }

  function denied(reason) {
    // Redirect with reason so login page can show a useful message
    sessionStorage.setItem('tb_admin_denied_reason', reason || 'not_authorized');
    window.location.replace('/admin-login.html');
  }

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

  function check() {
    var attempts = 0;
    var t = setInterval(function() {
      attempts++;
      if (attempts > 60) {  // ~12s — Clerk should be ready well before this
        clearInterval(t);
        denied('clerk_timeout');
        return;
      }
      if (!window.Clerk || typeof window.Clerk.addListener !== 'function') return;
      // Clerk loaded
      clearInterval(t);
      var user = window.Clerk.user;
      if (!user) {
        denied('not_signed_in');
        return;
      }
      if (!isAdmin(user)) {
        denied('not_authorized');
        return;
      }
      // Authorized — reveal the page
      reveal();

      // Watch for sign-out
      window.Clerk.addListener(function(resources) {
        if (!resources.user || !isAdmin(resources.user)) {
          denied('signed_out');
        }
      });
    }, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }
})();
