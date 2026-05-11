// admin-gate.js — runs on every /admin-*.html page (except admin-login.html)
// Verifies the signed-in Clerk user is on the admin allowlist.
// Non-admins are redirected to /admin-login.html with a clear message.
(function() {
  var ADMIN_EMAILS = ['admin@thebearing.io'];

  // Hide page contents instantly to prevent flash of admin UI before auth check
  var hideStyle = document.createElement('style');
  hideStyle.id = 'admin-gate-hide';
  hideStyle.textContent = 'body{visibility:hidden!important;}';
  (document.head || document.documentElement).appendChild(hideStyle);

  function reveal() {
    var s = document.getElementById('admin-gate-hide');
    if (s) s.remove();
  }

  function denied(reason) {
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
      evaluate();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
