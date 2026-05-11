// Populates the admin sidebar footer (#sb-user-avatar + #sb-user-name) from Clerk
(function() {
  function getInitials(name) {
    return String(name || '?').split(/\s+/).map(function(w){return w[0]||'';}).join('').substring(0,2).toUpperCase();
  }
  function apply(user) {
    if (!user) return;
    var name = [user.firstName, user.lastName].filter(Boolean).join(' ');
    if (!name && user.primaryEmailAddress) name = user.primaryEmailAddress.emailAddress.split('@')[0];
    var avatarEl = document.getElementById('sb-user-avatar');
    if (avatarEl) {
      if (user.imageUrl) {
        avatarEl.innerHTML = '<img src="' + user.imageUrl + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">';
      } else {
        avatarEl.textContent = getInitials(name);
      }
    }
    var nameEl = document.getElementById('sb-user-name');
    if (nameEl) nameEl.textContent = name || 'Admin';
  }
  function init() {
    var attempts = 0;
    var t = setInterval(function() {
      attempts++;
      if (attempts > 50) { clearInterval(t); return; }
      if (!window.Clerk || typeof window.Clerk.addListener !== 'function') return;
      if (window.Clerk.user) {
        clearInterval(t);
        apply(window.Clerk.user);
        window.Clerk.addListener(function(r) { if (r.user) apply(r.user); });
      }
    }, 200);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
