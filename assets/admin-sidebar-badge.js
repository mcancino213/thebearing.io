// Populates the Conversations sidebar badge with real unread count
// Used across all admin-*.html pages
(function() {
  function updateBadge() {
    fetch('/api/conversation')
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d) {
        var convs = (d.conversations || []).filter(function(c){ return c.status !== 'archived'; });
        var unread = convs.filter(function(c){ return c.unreadAdmin > 0; }).length;
        var badge = document.querySelector('.sb-badge');
        if (!badge) return;
        if (unread > 0) {
          badge.textContent = unread;
          badge.style.display = '';
        } else {
          badge.style.display = 'none';
        }
      })
      .catch(function(){});
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateBadge);
  } else {
    updateBadge();
  }
  
  // Refresh every 30 seconds
  setInterval(updateBadge, 30000);
})();
