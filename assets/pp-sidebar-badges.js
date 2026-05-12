// Partner portal — Conversations badge uses lean /api/unread-count
(function() {
  var PP_SLUG = 'nour-el-nil';
  var inFlight = false;

  function updateConvBadge() {
    if (inFlight || document.hidden) return;
    inFlight = true;
    fetch('/api/unread-count?role=partner&slug=' + PP_SLUG, { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d) {
        var unread = d.unread || 0;
        var links = document.querySelectorAll('.sb-item');
        links.forEach(function(link) {
          if (link.getAttribute('href') === 'pp-conversations' || link.getAttribute('href') === 'pp-conversations.html') {
            var badge = link.querySelector('.sb-badge');
            if (badge) {
              if (unread > 0) { badge.textContent = unread; badge.style.display = ''; }
              else badge.style.display = 'none';
            }
          }
        });
      })
      .catch(function(){})
      .finally(function(){ inFlight = false; });
  }

  function updateBookingsBadge() {
    fetch('/api/booking?slug=' + PP_SLUG)
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d) {
        var bookings = (d.bookings || []).filter(function(b){ return b.status !== 'cancelled'; });
        var links = document.querySelectorAll('.sb-item');
        links.forEach(function(link) {
          if (link.getAttribute('href') === 'pp-bookings' || link.getAttribute('href') === 'pp-bookings.html') {
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

  function init() {
    updateConvBadge();
    updateBookingsBadge();
    setInterval(updateConvBadge, 4000);
    setInterval(updateBookingsBadge, 60000);
    window.addEventListener('focus', updateConvBadge);
    document.addEventListener('visibilitychange', function(){ if (!document.hidden) updateConvBadge(); });
    window.refreshPpBadges = updateConvBadge;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
