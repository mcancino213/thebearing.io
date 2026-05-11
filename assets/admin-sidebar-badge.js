// Populates the Conversations sidebar badge with real unread count
// Used across all admin-*.html pages. Polls every 8s + on visibility/focus.
(function() {
  var lastTotal = -1;
  var inFlight = false;
  var originalTitle = document.title;
  
  function updateBadge() {
    if (inFlight) return;
    if (document.hidden) return; // skip while tab is hidden — focus event will refresh
    inFlight = true;
    fetch('/api/conversation', { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d) {
        var convs = (d.conversations || []).filter(function(c){ return c.status !== 'archived'; });
        var unread = convs.filter(function(c){ return c.unreadAdmin > 0; }).length;
        var badge = document.querySelector('.sb-badge');
        if (badge) {
          if (unread > 0) {
            badge.textContent = unread;
            badge.style.display = '';
          } else {
            badge.style.display = 'none';
          }
        }
        // Mirror unread count into page title for at-a-glance
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
    // Fast polling so admin sees new messages within ~8s
    setInterval(updateBadge, 8000);
    // Update when tab regains focus / becomes visible
    window.addEventListener('focus', updateBadge);
    document.addEventListener('visibilitychange', function(){ if (!document.hidden) updateBadge(); });
    // Expose for other scripts to trigger an immediate refresh
    window.refreshAdminUnreadBadge = updateBadge;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
