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
    // v73g: when the Clerk widget content makes the sheet taller than the
    // viewport (laptop screens, mobile), align-items:center pushes the top
    // of the sheet off-screen (Miguel's screenshot). Switch to flex-start
    // with overflow-y:auto so the user can scroll within the overlay and
    // sees the top of the modal. Padding-top gives breathing room.
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;display:flex;align-items:flex-start;justify-content:center;backdrop-filter:blur(6px);overflow-y:auto;padding:5vh 0;';

    // v73f: bumped max-width from 480 → 560 to fit Clerk's widget without
    // overflow. Clerk's mountSignIn renders a ~440px-wide card with its own
    // padding — the old 480px sheet was just barely wider, which caused the
    // widget to anchor left while our header stayed at full width on the
    // right, producing the broken layout Miguel screenshotted.
    var sheet = document.createElement('div');
    sheet.style.cssText = 'background:#faf7f1;border-radius:20px;width:100%;max-width:560px;padding:32px 28px 40px;box-shadow:0 20px 60px rgba(0,0,0,.25);transform:scale(.96);opacity:0;transition:transform .28s cubic-bezier(.32,.72,0,1),opacity .28s ease;margin:20px;';

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
    // v73f: removed inline flex-center on the mount container — Clerk's
    // widget has its own internal flex layout and our wrapper was conflicting
    // with it (Loading… text stayed visible alongside Clerk's mounted widget).
    // Now the mount container is just a min-height block; Clerk fills it.
    '<div id="tb-clerk-mount" style="min-height:200px;"><div id="tb-clerk-loading" style="color:#9a8e80;font-size:.8rem;text-align:center;padding:60px 0;">Loading sign-in…</div></div>';

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    _modalEl = overlay;

    // Animate in
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        sheet.style.transform = 'scale(1)';
        sheet.style.opacity = '1';
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
        tbAuth.dismiss();
        if (opts.onSuccess) opts.onSuccess(window.Clerk.user);
        return;
      }

      // v73f: include clean URLs (no .html) alongside legacy .html paths.
      // Cloudflare Pages serves /property?slug=X — that's the canonical form
      // now, not /property.html?slug=X. The old whitelist failed to match
      // and sent users to /my-account after sign-in, blowing away the
      // enquiry overlay they were in the middle of completing.
      var path = window.location.pathname || '/';
      var stayInPlacePaths = [
        '/property', '/property.html',
        '/nour-el-nil', '/nour-el-nil.html',
        '/my-account', '/my-account.html',
        '/conversations', '/conversations.html',
        '/bookings', '/bookings.html',
        '/saved', '/saved.html',
        '/lens', '/lens.html',
        '/preferences', '/preferences.html',
        '/settings', '/settings.html'
      ];
      var stayInPlace = stayInPlacePaths.some(function(p) {
        // Exact match (clean URL) OR prefix match (path === p covers clean,
        // path === p + '.html' or path.indexOf(p + '.html') covers .html).
        return path === p || path === (p + '.html') || path.indexOf(p + '.html') === 0;
      });
      var afterUrl = stayInPlace ? window.location.href : '/my-account.html';

      // v73f: drop the "Loading sign-in…" placeholder before mounting Clerk.
      // Clerk's mountSignIn appends to the container — it doesn't replace
      // existing children — so the placeholder text would stay visible
      // alongside the rendered widget, breaking the layout.
      var loadingEl = document.getElementById('tb-clerk-loading');
      if (loadingEl) loadingEl.remove();

      // Use Clerk's hosted sign-in page in an iframe as fallback
      // First try mountSignIn, fall back to redirect
      try {
        window.Clerk.mountSignIn(mountEl, {
          routing: 'virtual',
          afterSignInUrl: afterUrl,
          afterSignUpUrl: afterUrl,
        });
      } catch(e) {
        // Fallback: show a simple iframe with Clerk hosted UI
        mountEl.innerHTML = '<div style="text-align:center;padding:16px 0;">' +
          '<a href="' + CLERK_DOMAIN + '/sign-in?redirect_url=' + encodeURIComponent(afterUrl) + '" ' +
          'style="display:inline-block;padding:12px 28px;background:#b05830;color:#fff;border-radius:100px;font-family:Geist,sans-serif;font-size:.88rem;font-weight:600;text-decoration:none;">Continue with Google or email →</a>' +
          '<div style="font-size:.7rem;color:#9a8e80;margin-top:10px;">You\'ll be returned here after signing in.</div>' +
        '</div>';
      }

      // Poll for sign-in completion.
      // v73g: if Clerk does a full-page OAuth redirect to its dashboard-
      // configured home URL (instead of honoring our afterSignInUrl), this
      // poll never fires because the page has navigated away. But if the
      // popup OAuth flow stays in place, this catches the user signing in
      // and we run onSuccess. As an extra defence: if onSuccess is set
      // AND our afterUrl differs from current URL, we force-navigate too
      // — that way even if Clerk's virtual routing left us on a stale
      // page, the user lands where they expect.
      var pollInterval = setInterval(function() {
        if (window.Clerk && window.Clerk.user) {
          clearInterval(pollInterval);
          tbAuth.dismiss();
          if (opts.onSuccess) opts.onSuccess(window.Clerk.user);
        }
      }, 800);
    });
  }

  // ── Dismiss modal ────────────────────────────────────────────────────
  function dismiss() {
    if (_modalEl) {
      var sheet = _modalEl.querySelector('div');
      if (sheet) { sheet.style.transform = 'scale(.96)'; sheet.style.opacity = '0'; }
      setTimeout(function() {
        if (_modalEl) { _modalEl.remove(); _modalEl = null; }
      }, 300);
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
