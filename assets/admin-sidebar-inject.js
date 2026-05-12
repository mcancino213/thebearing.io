// admin-sidebar-inject.js — populates <aside id="admin-sidebar-mount"> with the
// shared admin sidebar markup, cached in sessionStorage so subsequent admin
// page loads inject synchronously (no network round-trip, no flash).
//
// Loading model:
//   1. First admin page load this session → fetch /assets/admin-sidebar.html,
//      cache it, inject it. Badge/user-name scripts find the DOM ready after
//      DOMContentLoaded as usual.
//   2. Every subsequent admin page load → read cache, inject synchronously
//      before DOMContentLoaded fires. Badge/user-name find their targets
//      immediately on first paint.
//
// Active state: <body data-page="settings"> → the matching <a data-page="settings">
// in the sidebar gets `.active` added.
//
// Cache invalidation: bump SIDEBAR_VERSION whenever admin-sidebar.html changes.
// The version is part of the storage key, so old cached copies are simply
// ignored (and eventually evicted by sessionStorage on session end).
(function() {
  var SIDEBAR_VERSION = 1;
  var STORAGE_KEY = 'tb_admin_sidebar_v' + SIDEBAR_VERSION;

  function applyActive(mount) {
    var page = (document.body && document.body.getAttribute('data-page')) || '';
    if (!page) return;
    var link = mount.querySelector('a[data-page="' + page + '"]');
    if (link) link.classList.add('active');
  }

  function inject(mount, html) {
    mount.innerHTML = html;
    applyActive(mount);
  }

  function loadFromCache() {
    try { return sessionStorage.getItem(STORAGE_KEY); } catch(e) { return null; }
  }
  function saveToCache(html) {
    try { sessionStorage.setItem(STORAGE_KEY, html); } catch(e) {}
  }

  function mount() {
    var el = document.getElementById('admin-sidebar-mount');
    if (!el) return;

    var cached = loadFromCache();
    if (cached) {
      inject(el, cached);
      return;
    }

    // First load this session — fetch and cache. Add `v` param so a CDN
    // misconfiguration can never serve a stale partial.
    fetch('/assets/admin-sidebar.html?v=' + SIDEBAR_VERSION, { cache: 'force-cache' })
      .then(function(r) { return r.ok ? r.text() : Promise.reject(r.status); })
      .then(function(html) {
        saveToCache(html);
        inject(el, html);
        // The badge & user-name scripts may have already run on DOMContentLoaded
        // and silently no-op'd because their targets didn't exist yet. Re-run
        // them now if they exposed re-init hooks.
        if (typeof window.refreshAdminUnreadBadge === 'function') {
          try { window.refreshAdminUnreadBadge(); } catch(e) {}
        }
        if (typeof window.refreshAdminSidebarUser === 'function') {
          try { window.refreshAdminSidebarUser(); } catch(e) {}
        }
      })
      .catch(function(err) {
        console.error('[admin-sidebar] fetch failed:', err);
        el.innerHTML = '<div style="padding:20px;color:rgba(255,255,255,.5);font-size:13px;">Sidebar failed to load. <a href="javascript:location.reload()" style="color:#c17f3e;">Reload</a></div>';
      });
  }

  // The mount element is created inline in each admin page <body>. We need to
  // wait until parser has seen it. If we're already past DOMContentLoaded we
  // can mount immediately; otherwise wait. In practice this script is loaded
  // RIGHT AFTER the <aside> mount element so document.getElementById should
  // work immediately even mid-parse.
  if (document.readyState === 'loading') {
    // Try immediate (works because the mount element appears just before us),
    // and also queue a fallback for DOMContentLoaded in case some other admin
    // page accidentally puts this script earlier.
    var done = false;
    function once() { if (done) return; done = true; mount(); }
    if (document.getElementById('admin-sidebar-mount')) {
      once();
    } else {
      document.addEventListener('DOMContentLoaded', once);
    }
  } else {
    mount();
  }
})();
