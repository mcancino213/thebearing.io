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
          if (link.getAttribute('href') === '/conversations' || link.getAttribute('href') === '/conversations.html' || link.textContent.indexOf('Conversations') >= 0) {
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
    // v73aa: /api/booking filters by `email`, not `guestId`. Previous code
    // sent `?guestId=X` which was silently ignored — endpoint returned ALL
    // bookings from ALL guests, badge count was meaningless. Fixed now.
    var primaryEmail = user.primaryEmailAddress && user.primaryEmailAddress.emailAddress;
    if (!primaryEmail) return;
    fetch('/api/booking?email=' + encodeURIComponent(primaryEmail))
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d) {
        // v73aa: badge counts only items needing customer action, not all
        // bookings. Previously it counted all non-cancelled bookings, so
        // having even one confirmed booking left the badge always-on.
        // New criteria:
        //   1. Offers waiting for customer's response (status:'offer_sent'
        //      with active_offer_id and not yet paid)
        //   2. New enquiries with no offer yet (waiting on partner, but
        //      customer still has a fresh ticket they may want to see)
        // Confirmed and cancelled bookings are static — no action needed.
        var needsAction = (d.bookings || []).filter(function(b) {
          if (b.status === 'cancelled') return false;
          if (b.status === 'confirmed') return false;
          // Offer waiting on customer
          if (b.status === 'offer_sent' && b.active_offer_id && b.paymentStatus !== 'deposit_paid') return true;
          // Fresh enquiry awaiting partner — surface to customer too so they
          // know they have a pending request
          if (b.status === 'enquiry') return true;
          return false;
        });
        var count = needsAction.length;
        var links = document.querySelectorAll('.sidebar-item');
        links.forEach(function(link) {
          if (link.getAttribute('href') === '/bookings' || link.getAttribute('href') === '/bookings.html' || link.textContent.indexOf('Bookings') >= 0) {
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
