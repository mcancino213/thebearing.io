// Customer-side sidebar populator with sessionStorage caching
(function() {
  var CACHE_KEY = 'tb_user_cache';
  // v74w: FM status cached separately so it can update independently of
  // the user record (FM gets reserved server-side after a deposit; we want
  // the badge to refresh on next page load even if user record hasn't changed).
  var FM_CACHE_KEY = 'tb_fm_cache';

  function wireSignOut() {
    // Find any tb-signout-btn (static HTML in every page) and wire its click handler
    var btns = document.querySelectorAll('.tb-signout-btn');
    btns.forEach(function(btn) {
      if (btn.__wired) return;
      btn.__wired = true;
      btn.addEventListener('click', async function() {
        // v73e: make sign-out bulletproof.
        // The previous version silently did NOTHING if window.Clerk wasn't
        // loaded at click time (early click, slow network, etc.). Now:
        //   1. Give immediate visual feedback so the click registers
        //   2. If Clerk isn't loaded yet, wait for it (up to 4s)
        //   3. Call signOut() and AWAIT it properly
        //   4. Clear local + session storage caches that might hold session
        //   5. Hard-redirect with cache-bust to ensure no stale state lingers

        // Disable button + show progress
        btn.disabled = true;
        var origLabel = btn.textContent;
        btn.textContent = 'Signing out…';
        btn.style.opacity = '.7';

        // Wait for Clerk to be available — up to 4s
        async function waitForClerk() {
          if (window.Clerk && typeof window.Clerk.signOut === 'function') return true;
          for (var i = 0; i < 40; i++) { // 40 × 100ms = 4s
            await new Promise(function(r){ setTimeout(r, 100); });
            if (window.Clerk && typeof window.Clerk.signOut === 'function') return true;
          }
          return false;
        }

        try {
          // Clear caches first so even if signOut() hangs, the next page load
          // doesn't show stale user details from sessionStorage.
          try { sessionStorage.removeItem(CACHE_KEY); } catch(e) {}
          try { sessionStorage.clear(); } catch(e) {}

          var clerkReady = await waitForClerk();
          if (clerkReady) {
            await window.Clerk.signOut();
          } else {
            console.warn('[Sign out] Clerk never loaded — proceeding with redirect anyway.');
          }
        } catch (err) {
          console.error('[Sign out] error:', err);
        }

        // Hard reload to a known sign-in entry point with cache bust.
        // Using location.replace so the previous page isn't in history
        // (so the back button can't return to a "signed-in-looking" view).
        window.location.replace('/?signedout=' + Date.now());
      });
    });
  }

  function applyToDOM(data) {
    if (!data) return;

    var avatarEl = document.querySelector('.sidebar-avatar');
    if (avatarEl) {
      if (data.avatarUrl) {
        avatarEl.innerHTML = '<img src="' + data.avatarUrl + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">';
      } else {
        avatarEl.textContent = data.initials || '?';
      }
    }

    var nameEl = document.querySelector('.sidebar-name');
    if (nameEl) nameEl.textContent = data.name || 'Guest';

    var emailEl = document.querySelector('.sidebar-email');
    if (emailEl) {
      emailEl.innerHTML = '';
      emailEl.textContent = data.email || '';
    }

    // Top-right nav avatar
    var navAvatar = document.querySelector('.nav-avatar');
    if (navAvatar) {
      if (data.avatarUrl) {
        navAvatar.innerHTML = '<img src="' + data.avatarUrl + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">';
      } else {
        navAvatar.textContent = data.initials || '';
      }
    }

    wireSignOut();

    var profile = document.querySelector('.sidebar-profile');
    if (profile) profile.classList.add('tb-ready');

    // v74w: Founding Member badge. Renders into #tb-fm-badge.
    // Priority: real FM cache → fall back to "Member since YYYY" → fall back to "Member".
    applyFmBadge(data);
  }

  // v74w: render the FM badge based on cached state + user createdAt fallback.
  function applyFmBadge(data) {
    var el = document.getElementById('tb-fm-badge');
    if (!el) return;
    var fm = null;
    try {
      var raw = sessionStorage.getItem(FM_CACHE_KEY);
      if (raw) fm = JSON.parse(raw);
    } catch(e) {}

    if (fm && fm.status === 'awarded' && fm.number) {
      el.innerHTML = '✦ Founding Member #' + fm.number;
      el.style.color = ''; // inherit
      return;
    }
    if (fm && fm.status === 'pending' && fm.number) {
      el.innerHTML = '✦ Founding Member <span style="opacity:.65;">#' + fm.number + ' · pending</span>';
      return;
    }
    // Fallback: "Member since YYYY" if we have a createdAt
    if (data && data.createdAtYear) {
      el.textContent = 'Member since ' + data.createdAtYear;
      return;
    }
    el.textContent = 'Member';
  }

  // v74w: fetch FM status from worker and cache it. Idempotent — only updates
  // if the response differs from cache.
  async function refreshFmStatus(userId) {
    if (!userId) return;
    try {
      var r = await fetch('/api/founding-member/me?guestId=' + encodeURIComponent(userId));
      if (!r.ok) return;
      var d = await r.json();
      if (!d || !d.ok) return;
      var payload = { status: d.status || 'none', number: d.number || null };
      try { sessionStorage.setItem(FM_CACHE_KEY, JSON.stringify(payload)); } catch(e) {}
      // Re-apply badge with the fresh data
      var cached = null;
      try { cached = sessionStorage.getItem(CACHE_KEY); cached = cached ? JSON.parse(cached) : null; } catch(e) {}
      applyFmBadge(cached);
    } catch (e) {
      // Non-fatal — leave the existing badge state
    }
  }

  function applyUser(user) {
    if (!user) return;
    var name = [user.firstName, user.lastName].filter(Boolean).join(' ');
    if (!name && user.primaryEmailAddress) {
      name = user.primaryEmailAddress.emailAddress.split('@')[0];
    }
    var email = user.primaryEmailAddress ? user.primaryEmailAddress.emailAddress : '';
    var initials = name.split(' ').map(function(w){return w[0]||''}).join('').toUpperCase().slice(0,2);
    // v74w: capture year from Clerk user createdAt for the "Member since YYYY" fallback
    var createdAtYear = '';
    try {
      var ca = user.createdAt;
      if (ca) {
        var d = (ca instanceof Date) ? ca : new Date(ca);
        if (!isNaN(d.getTime())) createdAtYear = String(d.getFullYear());
      }
    } catch(e) {}
    var data = { name: name, email: email, initials: initials, avatarUrl: user.imageUrl, createdAtYear: createdAtYear };
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch(e) {}
    applyToDOM(data);
    // v74w: refresh FM status async — uses Clerk user id as guestId
    refreshFmStatus(user.id);
  }

  function applyCacheNow() {
    try {
      var cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) applyToDOM(JSON.parse(cached));
    } catch(e) {}
  }

  function init() {
    applyCacheNow();
    wireSignOut(); // Always wire even if no cache, so button works on first sign-in too

    var attempts = 0;
    var t = setInterval(function() {
      attempts++;
      if (attempts > 50) { clearInterval(t); return; }
      if (!window.Clerk || typeof window.Clerk.addListener !== 'function') return;
      if (window.Clerk.user) {
        clearInterval(t);
        applyUser(window.Clerk.user);
        window.Clerk.addListener(function(resources) {
          if (resources.user) applyUser(resources.user);
        });
      }
    }, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
