// ── TheBearing Auth Helper ─────────────────────────────────────────────
// Drop this script on any page that needs auth-gated actions.
// Usage:
//   tbAuth.requireUser(function(user) { /* proceed */ });
//   tbAuth.getUser() → user object or null
//   tbAuth.showSignIn({ title, subtitle, onSuccess })

var tbAuth = (function() {

  var CLERK_KEY = 'pk_test_bWVhc3VyZWQtam9leS0xNS5jbGVyay5hY2NvdW50cy5kZXYk';
  var CLERK_DOMAIN = 'https://measured-joey-15.clerk.accounts.dev';
  var _clerkReady = false;
  var _readyCallbacks = [];
  var _modalEl = null;

  // ── Load Clerk SDK ───────────────────────────────────────────────────
  function loadClerk(cb) {
    if (window.Clerk && window.Clerk.user !== undefined) {
      cb();
      return;
    }
    if (window.__tbClerkLoading) {
      _readyCallbacks.push(cb);
      return;
    }
    window.__tbClerkLoading = true;
    _readyCallbacks.push(cb);

    // Load UI script first
    var uiScript = document.createElement('script');
    uiScript.src = CLERK_DOMAIN + '/npm/@clerk/ui@1/dist/ui.browser.js';
    uiScript.crossOrigin = 'anonymous';
    document.head.appendChild(uiScript);

    // Load main Clerk script
    var script = document.createElement('script');
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.setAttribute('data-clerk-publishable-key', CLERK_KEY);
    script.src = CLERK_DOMAIN + '/npm/@clerk/clerk-js@6/dist/clerk.browser.js';
    script.onload = async function() {
      try {
        await window.Clerk.load({
          ui: { ClerkUI: window.__internal_ClerkUICtor }
        });
        _clerkReady = true;
        _readyCallbacks.forEach(function(fn) { fn(); });
        _readyCallbacks = [];
      } catch(e) {
        console.error('[tbAuth] Clerk load error:', e);
      }
    };
    document.head.appendChild(script);
  }

  // ── Get current user ─────────────────────────────────────────────────
  function getUser() {
    if (!window.Clerk) return null;
    return window.Clerk.user || null;
  }

  // ── Require user — calls cb(user) if signed in, shows modal if not ──
  function requireUser(cb, opts) {
    loadClerk(function() {
      var user = getUser();
      if (user) {
        cb(user);
      } else {
        showSignIn(Object.assign({ onSuccess: cb }, opts || {}));
      }
    });
  }

  // ── Show sign-in modal ───────────────────────────────────────────────
  function showSignIn(opts) {
    opts = opts || {};
    if (_modalEl) _modalEl.remove();

    var overlay = document.createElement('div');
    overlay.id = 'tb-auth-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(6px);';

    var sheet = document.createElement('div');
    sheet.style.cssText = 'background:#faf7f1;border-radius:24px 24px 0 0;width:100%;max-width:480px;padding:32px 28px 40px;box-shadow:0 -20px 60px rgba(0,0,0,.2);transform:translateY(100%);transition:transform .38s cubic-bezier(.32,.72,0,1);';

    // Header
    var title = opts.title || 'Sign in to continue';
    var subtitle = opts.subtitle || 'Create a free account or sign in with Google or Apple to send your enquiry.';

    sheet.innerHTML = '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:6px;">' +
      '<div>' +
        '<div style="font-size:.58rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#b05830;margin-bottom:6px;">The Bearing</div>' +
        '<div style="font-family:\'Instrument Serif\',serif;font-size:1.5rem;color:#1e1810;line-height:1.2;">' + title + '</div>' +
      '</div>' +
      '<button onclick="tbAuth.dismiss()" style="width:32px;height:32px;border-radius:50%;border:1px solid #e5e0d8;background:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
        '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="#1e1810" stroke-width="2.5" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>' +
      '</button>' +
    '</div>' +
    '<div style="font-size:.8rem;color:#7a6a58;line-height:1.6;margin-bottom:20px;">' + subtitle + '</div>' +
    '<div id="tb-clerk-mount" style="min-height:60px;"></div>';

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    _modalEl = overlay;

    // Slide up
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        sheet.style.transform = 'translateY(0)';
      });
    });

    // Close on backdrop click
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) tbAuth.dismiss();
    });

    // Mount Clerk sign-in UI
    loadClerk(function() {
      var mountEl = document.getElementById('tb-clerk-mount');
      if (!mountEl) return;

      if (window.Clerk.user) {
        // Already signed in — call success immediately
        tbAuth.dismiss();
        if (opts.onSuccess) opts.onSuccess(window.Clerk.user);
        return;
      }

      // Mount Clerk's built-in sign-in component
      window.Clerk.mountSignIn(mountEl, {
        routing: 'virtual',
        afterSignInUrl: window.location.href,
        afterSignUpUrl: window.location.href,
      });

      // Poll for sign-in completion
      var pollInterval = setInterval(function() {
        if (window.Clerk.user) {
          clearInterval(pollInterval);
          tbAuth.dismiss();
          if (opts.onSuccess) opts.onSuccess(window.Clerk.user);
        }
      }, 500);
    });
  }

  // ── Dismiss modal ────────────────────────────────────────────────────
  function dismiss() {
    if (_modalEl) {
      var sheet = _modalEl.querySelector('div');
      if (sheet) sheet.style.transform = 'translateY(100%)';
      setTimeout(function() {
        if (_modalEl) { _modalEl.remove(); _modalEl = null; }
      }, 400);
    }
  }

  // ── Sign out ─────────────────────────────────────────────────────────
  function signOut(cb) {
    loadClerk(function() {
      window.Clerk.signOut().then(cb || function() {});
    });
  }

  return { requireUser, getUser, showSignIn, dismiss, signOut, loadClerk };
})();
