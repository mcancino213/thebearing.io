// Populate sidebar with real Clerk user data on customer account pages
// Pages: bookings, saved, lens, preferences, settings, conversations
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

    // Avatar
    var avatarEl = document.querySelector('.sidebar-avatar');
    if (avatarEl) {
      if (avatarUrl) {
        avatarEl.innerHTML = '<img src="' + avatarUrl + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">';
      } else {
        avatarEl.textContent = initials || '?';
      }
    }

    // Name
    var nameEl = document.querySelector('.sidebar-name');
    if (nameEl) nameEl.textContent = name || 'Guest';

    // Email — Cloudflare obfuscates real emails with .__cf_email__ links sometimes
    var emailEl = document.querySelector('.sidebar-email');
    if (emailEl) {
      emailEl.innerHTML = '';
      emailEl.textContent = email;
    }
  }

  function setupSignOut() {
    // Replace any "Sign out" link/button with a real one wired to Clerk
    var btns = document.querySelectorAll('.sidebar-signout, [data-signout], button.signout-btn');
    btns.forEach(function(btn) {
      btn.onclick = async function(e) {
        e.preventDefault();
        if (window.Clerk) {
          await window.Clerk.signOut();
          window.location.href = '/';
        }
      };
    });
  }

  function init() {
    // Wait for Clerk to be initialized
    var attempts = 0;
    var t = setInterval(function() {
      attempts++;
      if (window.Clerk && typeof window.Clerk.addListener === 'function') {
        clearInterval(t);
        var user = window.Clerk.user;
        if (user) {
          applyUser(user);
          setupSignOut();
        } else {
          // User not signed in — redirect to home or my-account where the sign-in modal lives
          window.location.href = '/my-account.html';
          return;
        }
        // Listen for sign-out
        window.Clerk.addListener(function(resources) {
          if (!resources.user) {
            window.location.href = '/';
          }
        });
      } else if (attempts > 40) {
        clearInterval(t);
      }
    }, 200);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('load', init);
  } else {
    init();
  }
})();
