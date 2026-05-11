// admin-fetch.js — wraps window.fetch to attach admin auth headers on /api/ calls
// Loaded after admin-gate.js so Clerk.user is available.
(function() {
  var origFetch = window.fetch.bind(window);

  function getAdminEmail() {
    try {
      if (window.Clerk && window.Clerk.user) {
        var u = window.Clerk.user;
        if (u.primaryEmailAddress && u.primaryEmailAddress.emailAddress) {
          return u.primaryEmailAddress.emailAddress;
        }
        if (u.emailAddresses && u.emailAddresses.length) {
          return u.emailAddresses[0].emailAddress;
        }
      }
    } catch(e) {}
    return null;
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
      var email = getAdminEmail();
      if (email && !init.headers.has('X-Admin-Email')) init.headers.set('X-Admin-Email', email);
      var token = await getSessionToken();
      if (token && !init.headers.has('X-Clerk-Session')) init.headers.set('X-Clerk-Session', token);
    }
    return origFetch(input, init);
  };
})();
