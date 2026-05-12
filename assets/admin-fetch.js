// admin-fetch.js — wraps window.fetch to attach admin auth headers on /api/ calls
// Loaded after admin-gate.js so Clerk.user is available.
//
// Sends ALL of the user's verified emails (primary first, then secondaries) as a
// comma-separated X-Admin-Email header. The worker checks each against the
// allowlist — so a Clerk account whose PRIMARY email isn't on the allowlist but
// whose SECONDARY email is (e.g. mcancino@gmail.com primary + admin@thebearing.io
// secondary) is still recognised as an admin. This matches how admin-gate.js
// evaluates the client-side gate.
(function() {
  var origFetch = window.fetch.bind(window);

  function getAdminEmails() {
    var emails = [];
    try {
      if (window.Clerk && window.Clerk.user) {
        var u = window.Clerk.user;
        // Primary first
        if (u.primaryEmailAddress && u.primaryEmailAddress.emailAddress) {
          emails.push(u.primaryEmailAddress.emailAddress);
        }
        // Then any other linked emails
        if (Array.isArray(u.emailAddresses)) {
          u.emailAddresses.forEach(function(e) {
            if (e && e.emailAddress && emails.indexOf(e.emailAddress) === -1) {
              emails.push(e.emailAddress);
            }
          });
        }
      }
    } catch(e) {}
    return emails;
  }

  async function getSessionToken() {
    try {
      if (window.Clerk && window.Clerk.session) {
        return await window.Clerk.session.getToken();
      }
    } catch(e) {}
    return null;
  }

  window.fetch = async function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    // Only attach auth headers to our own /api/ calls
    if (url.indexOf('/api/') === 0 || url.indexOf(location.origin + '/api/') === 0) {
      init = init || {};
      init.headers = new Headers(init.headers || {});
      var emails = getAdminEmails();
      if (emails.length && !init.headers.has('X-Admin-Email')) {
        // Comma-separated list — worker splits and checks each against allowlist
        init.headers.set('X-Admin-Email', emails.join(','));
      }
      var token = await getSessionToken();
      if (token && !init.headers.has('X-Clerk-Session')) init.headers.set('X-Clerk-Session', token);
    }
    return origFetch(input, init);
  };
})();
