// Partner portal sidebar badge updater
(function() {
  var PP_SLUG = 'nour-el-nil'; // TODO: replace with real partner auth context

  function updateBadges() {
    // Conversations
    fetch('/api/conversation?slug=' + PP_SLUG)
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d) {
        var convs = (d.conversations || []).filter(function(c){ return c.status !== 'archived'; });
        // For partner portal, unread = unreadAdmin (messages from guest waiting for partner reply)
        var unread = convs.reduce(function(sum, c){ return sum + (c.unreadAdmin || 0); }, 0);
        var links = document.querySelectorAll('.sb-item');
        links.forEach(function(link) {
          if (link.getAttribute('href') === 'pp-conversations.html') {
            var badge = link.querySelector('.sb-badge');
            if (badge) {
              if (unread > 0) { badge.textContent = unread; badge.style.display = ''; }
              else badge.style.display = 'none';
            }
          }
        });
      })
      .catch(function(){});

    // Bookings
    fetch('/api/booking?slug=' + PP_SLUG)
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d) {
        var bookings = (d.bookings || []).filter(function(b){ return b.status !== 'cancelled'; });
        var links = document.querySelectorAll('.sb-item');
        links.forEach(function(link) {
          if (link.getAttribute('href') === 'pp-bookings.html') {
            var badge = link.querySelector('.sb-badge');
            if (badge) {
              if (bookings.length > 0) { badge.textContent = bookings.length; badge.style.display = ''; }
              else badge.style.display = 'none';
            }
          }
        });
      })
      .catch(function(){});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateBadges);
  } else {
    updateBadges();
  }
  setInterval(updateBadges, 8000);
  window.addEventListener('focus', updateBadges);
  document.addEventListener('visibilitychange', function(){ if (!document.hidden) updateBadges(); });
  window.refreshPpBadges = updateBadges;
})();
