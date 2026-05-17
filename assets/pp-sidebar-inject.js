// pp-sidebar-inject.js — populates <aside id="pp-sidebar-mount"> with the
// shared partner sidebar markup, cached in sessionStorage so subsequent
// partner page loads inject synchronously (no network round-trip, no flash).
//
// Mirrors assets/admin-sidebar-inject.js. Introduced in v74s to fix
// navigation flash on partner-portal menu clicks. The root cause analysis
// in the v74r investigation was inconclusive from static evidence — partner
// pages had no `.account-wrap{opacity:0}` style rule (the customer-side
// cause), no body-hide gating, and identical font/sidebar CSS across pages.
// But the inlined sidebar markup was byte-different across pages (active
// class moved, plus a few stray id attrs on context elements) and the
// hypothesis is that subtle byte-differences in view-transition snapshots
// were producing the small visual jump the user perceived as a flash.
//
// Loading model (identical to admin):
//   1. First partner page load this session → fetch /assets/pp-sidebar.html,
//      cache it, inject it.
//   2. Every subsequent partner page load → read cache, inject synchronously
//      before DOMContentLoaded fires. Now byte-identical bytes on every load
//      means view transitions get matching snapshots — clean morph.
//
// Active state: <body data-page="pp-bookings"> → the matching
// <a data-page="pp-bookings"> in the sidebar gets `.active` added.
//
// Badge updates: pp-sidebar-badges.js stays a separate file; it runs on
// DOMContentLoaded as before. Its querySelectorAll('.sb-item') runs AFTER
// this script has injected the sidebar (admin-sidebar-inject does the same
// thing). If the first-session-load fetch is slow, the badge query might
// run before the sidebar exists and silently no-op — pp-sidebar-badges
// recovers on its 4s interval, so the badge will appear within a few
// seconds at worst. Acceptable trade-off for the no-flash navigation.
//
// Cache invalidation: bump SIDEBAR_VERSION whenever pp-sidebar.html changes.
(function() {
  var SIDEBAR_VERSION = 1;
  var STORAGE_KEY = 'tb_pp_sidebar_v' + SIDEBAR_VERSION;

  function applyActive(mount) {
    var page = (document.body && document.body.getAttribute('data-page')) || '';
    if (!page) return;
    var link = mount.querySelector('a[data-page="' + page + '"]');
    if (link) link.classList.add('active');
  }

  function inject(mount, html) {
    mount.innerHTML = html;
    applyActive(mount);
    // v73f: preserve ?as=X across partner-portal navigation. If the current
    // URL has ?as=X, rewrite every `.sb-item` sidebar link to carry the same
    // param. This used to live in pp-sidebar-badges.js but it ran on
    // DOMContentLoaded; since the sidebar is now injected by THIS script
    // (which may run after DOMContentLoaded on first session load), we
    // duplicate the rewrite here so it always runs immediately after the
    // sidebar appears.
    try {
      var asParam = new URLSearchParams(location.search).get('as');
      if (asParam) {
        var encoded = encodeURIComponent(asParam.trim());
        mount.querySelectorAll('.sb-item').forEach(function(link) {
          var href = link.getAttribute('href');
          if (!href || href.indexOf('://') !== -1 || href.charAt(0) === '#') return;
          var clean = href.split('?')[0];
          link.setAttribute('href', clean + '?as=' + encoded);
        });
      }
    } catch(e) {}
  }

  function loadFromCache() {
    try { return sessionStorage.getItem(STORAGE_KEY); } catch(e) { return null; }
  }
  function saveToCache(html) {
    try { sessionStorage.setItem(STORAGE_KEY, html); } catch(e) {}
  }

  function mount() {
    var el = document.getElementById('pp-sidebar-mount');
    if (!el) return;

    var cached = loadFromCache();
    if (cached) {
      inject(el, cached);
      return;
    }

    fetch('/assets/pp-sidebar.html?v=' + SIDEBAR_VERSION, { cache: 'force-cache' })
      .then(function(r) { return r.ok ? r.text() : Promise.reject(r.status); })
      .then(function(html) {
        saveToCache(html);
        inject(el, html);
        // The badge script may have already run on DOMContentLoaded and
        // silently no-op'd. Re-run if it exposed a hook.
        if (typeof window.refreshPpBadges === 'function') {
          try { window.refreshPpBadges(); } catch(e) {}
        }
      })
      .catch(function(err) {
        console.error('[pp-sidebar] fetch failed:', err);
        el.innerHTML = '<div style="padding:20px;color:rgba(255,255,255,.5);font-size:13px;">Sidebar failed to load. <a href="javascript:location.reload()" style="color:#c17f3e;">Reload</a></div>';
      });
  }

  if (document.readyState === 'loading') {
    var done = false;
    function once() { if (done) return; done = true; mount(); }
    if (document.getElementById('pp-sidebar-mount')) {
      once();
    } else {
      document.addEventListener('DOMContentLoaded', once);
    }
  } else {
    mount();
  }
})();
