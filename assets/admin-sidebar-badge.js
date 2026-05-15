// Admin sidebar badges (v73ah)
//  - Conversations badge: uses /api/unread-count?role=admin (unread messages)
//  - Bookings badge: counts items needing admin attention
//      - Newly confirmed bookings unseen by admin (seenByAdmin !== true)
//    (Future: could add pending enquiries needing admin review, etc.)
//
// Both poll every ~5s while tab is visible. Updates on focus/visibilitychange.
(function() {
  var lastConvTotal = -1;
  var convInFlight = false;
  var bookingsInFlight = false;
  var originalTitle = document.title;

  function updateConvBadge() {
    if (convInFlight) return;
    if (document.hidden) return;
    convInFlight = true;
    fetch('/api/unread-count?role=admin', { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d) {
        var unread = d.unread || 0;
        // Target the Conversations sb-badge specifically \u2014 the Bookings badge
        // we added in v73ah also matches .sb-badge so we need to exclude it.
        var badges = document.querySelectorAll('.sb-badge:not(.sb-badge-bookings)');
        badges.forEach(function(badge) {
          if (unread > 0) { badge.textContent = unread; badge.style.display = ''; }
          else badge.style.display = 'none';
        });
        if (unread !== lastConvTotal) {
          if (unread > 0) {
            document.title = '(' + unread + ') ' + originalTitle.replace(/^\(\d+\)\s*/, '');
          } else {
            document.title = originalTitle.replace(/^\(\d+\)\s*/, '');
          }
          lastConvTotal = unread;
        }
      })
      .catch(function(){})
      .finally(function(){ convInFlight = false; });
  }

  function updateBookingsBadge() {
    if (bookingsInFlight) return;
    if (document.hidden) return;
    bookingsInFlight = true;
    fetch('/api/booking', { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d) {
        // v73ah: count newly confirmed bookings the admin hasn't yet seen.
        // The Stripe webhook + sync-payment set seenByAdmin=false on
        // confirmation. The flag clears when admin opens the booking detail
        // (POST /api/booking/mark-seen with role='admin').
        //
        // Currently this is the ONLY admin-side action item we badge for.
        // (Could later add: pending refunds, partner disputes, etc.)
        var needsAttention = (d.bookings || []).filter(function(b) {
          return b.status === 'confirmed' && b.seenByAdmin !== true;
        });
        var badge = document.querySelector('.sb-badge-bookings');
        if (badge) {
          if (needsAttention.length > 0) {
            badge.textContent = needsAttention.length;
            badge.style.display = '';
          } else {
            badge.style.display = 'none';
          }
        }
      })
      .catch(function(){})
      .finally(function(){ bookingsInFlight = false; });
  }

  function updateAll() {
    updateConvBadge();
    updateBookingsBadge();
  }

  function init() {
    updateAll();
    // Conversations refreshes more aggressively because messages are real-time.
    // Bookings can refresh more leisurely \u2014 confirmations are less frequent.
    setInterval(updateConvBadge, 4000);
    setInterval(updateBookingsBadge, 30000);
    window.addEventListener('focus', updateAll);
    document.addEventListener('visibilitychange', function(){ if (!document.hidden) updateAll(); });
    window.refreshAdminUnreadBadge = updateConvBadge;
    window.refreshAdminBookingsBadge = updateBookingsBadge;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
