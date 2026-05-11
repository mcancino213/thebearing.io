// Customer sidebar — Conversations badge uses lean /api/unread-count
// Bookings badge still hits /api/booking (less frequently)
(function() {
  var inFlight = false;

  function updateConvBadge() {
    var user = window.Clerk && window.Clerk.user;
    if (!user || inFlight || document.hidden) return;
    inFlight = true;
    fetch('/api/unread-count?role=guest&guestId=' + encodeURIComponent(user.id), { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d) {
        var unread = d.unread || 0;
        var links = document.querySelectorAll('.sidebar-item');
        links.forEach(function(link) {
          if (link.getAttribute('href') === '/conversations.html' || link.textContent.indexOf('Conversations') >= 0) {
            var badge = link.querySelector('.sidebar-badge');
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
    var user = window.Clerk && window.Clerk.user;
    if (!user) return;
    fetch('/api/booking?guestId=' + encodeURIComponent(user.id))
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d) {
        var count = (d.bookings || []).filter(function(b){ return b.status !== 'cancelled'; }).length;
        var links = document.querySelectorAll('.sidebar-item');
        links.forEach(function(link) {
          if (link.getAttribute('href') === '/bookings.html' || link.textContent.indexOf('Bookings') >= 0) {
            var badge = link.querySelector('.sidebar-badge');
            if (badge) {
              if (count > 0) { badge.textContent = count; badge.style.display = ''; }
              else badge.style.display = 'none';
            }
          }
        });
      })
      .catch(function(){});
  }

  function init() {
    var attempts = 0;
    var t = setInterval(function() {
      attempts++;
      if (window.Clerk && window.Clerk.user) {
        clearInterval(t);
        updateConvBadge();
        updateBookingsBadge();
        // Convs poll fast (lean endpoint), bookings poll slow (heavier endpoint)
        setInterval(updateConvBadge, 4000);
        setInterval(updateBookingsBadge, 60000);
        window.addEventListener('focus', updateConvBadge);
        document.addEventListener('visibilitychange', function(){ if (!document.hidden) updateConvBadge(); });
        window.refreshCustomerBadges = updateConvBadge;
      } else if (attempts > 25) {
        clearInterval(t);
      }
    }, 250);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('load', init);
  } else {
    init();
  }
})();
