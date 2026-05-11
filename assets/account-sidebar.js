// Customer-side sidebar populator with sessionStorage caching
(function() {
  var CACHE_KEY = 'tb_user_cache';

  function wireSignOut() {
    // Find any tb-signout-btn (static HTML in every page) and wire its click handler
    var btns = document.querySelectorAll('.tb-signout-btn');
    btns.forEach(function(btn) {
      if (btn.__wired) return;
      btn.__wired = true;
      btn.addEventListener('click', async function() {
        try { sessionStorage.removeItem(CACHE_KEY); } catch(e) {}
        if (window.Clerk) {
          await window.Clerk.signOut();
          window.location.href = '/';
        }
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
  }

  function applyUser(user) {
    if (!user) return;
    var name = [user.firstName, user.lastName].filter(Boolean).join(' ');
    if (!name && user.primaryEmailAddress) {
      name = user.primaryEmailAddress.emailAddress.split('@')[0];
    }
    var email = user.primaryEmailAddress ? user.primaryEmailAddress.emailAddress : '';
    var initials = name.split(' ').map(function(w){return w[0]||''}).join('').toUpperCase().slice(0,2);
    var data = { name: name, email: email, initials: initials, avatarUrl: user.imageUrl };
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch(e) {}
    applyToDOM(data);
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
