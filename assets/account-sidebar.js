// Customer-side sidebar populator with sessionStorage caching for instant render
(function() {
  var CACHE_KEY = 'tb_user_cache';

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

    // Add Sign out button only if no sign-out already exists
    if (!document.querySelector('.tb-signout-btn')) {
      var sidebarBtns = document.querySelectorAll('.sidebar-profile button, .sidebar button');
      var hasSignOut = false;
      sidebarBtns.forEach(function(b) {
        if ((b.textContent || '').trim().toLowerCase() === 'sign out') hasSignOut = true;
      });
      if (!hasSignOut) {
        var signOutBtn = document.createElement('button');
        signOutBtn.className = 'tb-signout-btn';
        signOutBtn.textContent = 'Sign out';
        signOutBtn.style.cssText = 'margin-top:12px;width:100%;padding:8px;border:1px solid var(--border-hi,#e8dfd0);border-radius:8px;background:transparent;color:var(--stone,#9a8e80);font-family:Geist,sans-serif;font-size:.8rem;cursor:pointer;';
        signOutBtn.onclick = async function() {
          try { sessionStorage.removeItem(CACHE_KEY); } catch(e) {}
          if (window.Clerk) {
            await window.Clerk.signOut();
            window.location.href = '/';
          }
        };
        var memberTag = document.querySelector('.sidebar-member');
        if (memberTag && memberTag.parentNode) {
          memberTag.parentNode.insertBefore(signOutBtn, memberTag.nextSibling);
        } else {
          var profileForBtn = document.querySelector('.sidebar-profile');
          if (profileForBtn) profileForBtn.appendChild(signOutBtn);
        }
      }
    }

    // Reveal
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

  // Apply cached data immediately for instant render
  function applyCacheNow() {
    try {
      var cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) applyToDOM(JSON.parse(cached));
    } catch(e) {}
  }

  function init() {
    applyCacheNow();

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
