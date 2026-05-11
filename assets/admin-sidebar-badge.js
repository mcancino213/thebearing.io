// Admin sidebar Conversations badge — uses lean /api/unread-count endpoint
// Polls every 4s while tab is visible. Updates on focus/visibilitychange.
(function() {
  var lastTotal = -1;
  var inFlight = false;
  var originalTitle = document.title;

  function updateBadge() {
    if (inFlight) return;
    if (document.hidden) return;
    inFlight = true;
    fetch('/api/unread-count?role=admin', { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d) {
        var unread = d.unread || 0;
        var badge = document.querySelector('.sb-badge');
        if (badge) {
          if (unread > 0) { badge.textContent = unread; badge.style.display = ''; }
          else badge.style.display = 'none';
        }
        if (unread !== lastTotal) {
          if (unread > 0) {
            document.title = '(' + unread + ') ' + originalTitle.replace(/^\(\d+\)\s*/, '');
          } else {
            document.title = originalTitle.replace(/^\(\d+\)\s*/, '');
          }
          lastTotal = unread;
        }
      })
      .catch(function(){})
      .finally(function(){ inFlight = false; });
  }

  function init() {
    updateBadge();
    setInterval(updateBadge, 4000);
    window.addEventListener('focus', updateBadge);
    document.addEventListener('visibilitychange', function(){ if (!document.hidden) updateBadge(); });
    window.refreshAdminUnreadBadge = updateBadge;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
