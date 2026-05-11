// Populate sidebar with real Clerk user data on customer account pages
// Waits for Clerk.user to actually exist before applying.
// Does NOT redirect — pages handle auth themselves.
(function() {
  function applyUser(user) {
    if (!user) return;

    var name = [user.firstName, user.lastName].filter(Boolean).join(' ');
    if (!name && user.primaryEmailAddress) {
      name = user.primaryEmailAddress.emailAddress.split('@')[0];
    }
    var email = user.primaryEmailAddress ? user.primaryEmailAddress.emailAddress : '';
    var initials = name.split(' ').map(function(w){return w[0]||''}).join('').toUpperCase().slice(0,2);
    var avatarUrl = user.imageUrl;

    var avatarEl = document.querySelector('.sidebar-avatar');
    if (avatarEl) {
      if (avatarUrl) {
        avatarEl.innerHTML = '<img src="' + avatarUrl + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">';
      } else {
        avatarEl.textContent = initials || '?';
      }
    }

    var nameEl = document.querySelector('.sidebar-name');
    if (nameEl) nameEl.textContent = name || 'Guest';

    var emailEl = document.querySelector('.sidebar-email');
    if (emailEl) {
      emailEl.innerHTML = '';
      emailEl.textContent = email;
    }

    // Add Sign out button (after the founding member tag) — same as my-account.html
    if (!document.querySelector('.tb-signout-btn')) {
      var signOutBtn = document.createElement('button');
      signOutBtn.className = 'tb-signout-btn';
      signOutBtn.textContent = 'Sign out';
      signOutBtn.style.cssText = 'margin-top:12px;width:100%;padding:8px;border:1px solid var(--border-hi,#e8dfd0);border-radius:8px;background:transparent;color:var(--stone,#9a8e80);font-family:Geist,sans-serif;font-size:.8rem;cursor:pointer;';
      signOutBtn.onclick = async function() {
        if (window.Clerk) {
          await window.Clerk.signOut();
          window.location.href = '/';
        }
      };
      var memberTag = document.querySelector('.sidebar-member');
      if (memberTag && memberTag.parentNode) {
        memberTag.parentNode.insertBefore(signOutBtn, memberTag.nextSibling);
      } else {
        var profile = document.querySelector('.sidebar-profile');
        if (profile) profile.appendChild(signOutBtn);
      }
    }

    // Reveal the profile area
    var profile = document.querySelector('.sidebar-profile');
    if (profile) profile.classList.add('tb-ready');
  }

  function init() {
    // Poll for Clerk to finish loading AND have a user
    var attempts = 0;
    var t = setInterval(function() {
      attempts++;
      // Stop after 10 seconds
      if (attempts > 50) { clearInterval(t); return; }
      if (!window.Clerk || typeof window.Clerk.addListener !== 'function') return;

      // Clerk is loaded — check for user
      if (window.Clerk.user) {
        clearInterval(t);
        applyUser(window.Clerk.user);
        // Subscribe to changes for sign-in/out during session
        window.Clerk.addListener(function(resources) {
          if (resources.user) applyUser(resources.user);
        });
      }
      // If no user yet, keep polling — the user might still be loading
    }, 200);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('load', init);
  } else {
    init();
  }
})();
