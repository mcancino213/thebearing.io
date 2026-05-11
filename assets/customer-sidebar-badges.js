// Customer-side sidebar badge updater
// Sets real unread counts for Bookings & Conversations sidebar items
(function() {
  function updateBadges() {
    var user = window.Clerk && window.Clerk.user;
    if (!user) return;

    // Conversations badge
    fetch('/api/conversation?guestId=' + encodeURIComponent(user.id))
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d) {
        var convs = (d.conversations || []).filter(function(c){ return c.status !== 'archived'; });
        var unread = convs.reduce(function(sum, c){ return sum + (c.unreadGuest || 0); }, 0);
        // Find the Conversations badge specifically
        var links = document.querySelectorAll('.sidebar-item');
        links.forEach(function(link) {
          if (link.getAttribute('href') === '/channels.html' || link.textContent.indexOf('Conversations') >= 0) {
            var badge = link.querySelector('.sidebar-badge');
            if (badge) {
              if (unread > 0) {
                badge.textContent = unread;
                badge.style.display = '';
              } else {
                badge.style.display = 'none';
              }
            }
          }
        });
      })
      .catch(function(){});

    // Bookings badge
    fetch('/api/booking?guestId=' + encodeURIComponent(user.id))
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d) {
        var bookings = (d.bookings || []);
        // Count active bookings (not cancelled)
        var count = bookings.filter(function(b){ return b.status !== 'cancelled'; }).length;
        var links = document.querySelectorAll('.sidebar-item');
        links.forEach(function(link) {
          if (link.getAttribute('href') === '/bookings.html' || link.textContent.indexOf('Bookings') >= 0) {
            var badge = link.querySelector('.sidebar-badge');
            if (badge) {
              if (count > 0) {
                badge.textContent = count;
                badge.style.display = '';
              } else {
                badge.style.display = 'none';
              }
            }
          }
        });
      })
      .catch(function(){});
  }

  function init() {
    // Wait for Clerk to be ready
    var attempts = 0;
    var t = setInterval(function() {
      attempts++;
      if (window.Clerk && window.Clerk.user) {
        clearInterval(t);
        updateBadges();
        setInterval(updateBadges, 30000);
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
