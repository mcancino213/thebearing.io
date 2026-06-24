// Partner portal — Conversations badge uses lean /api/unread-count
(function() {
  // v73f: ?as=X URL param overrides default slug (for cross-partner testing)
  var PP_SLUG = (new URLSearchParams(location.search).get('as') || 'nour-el-nil-x').trim();
  var inFlight = false;

  function updateConvBadge() {
    if (inFlight || document.hidden) return;
    inFlight = true;
    fetch('/api/unread-count?role=partner&slug=' + PP_SLUG, { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d) {
        var unread = d.unread || 0;
        var hasLoop = !!d.hasLoop; // v74b: terracotta border hint when loop-unread is rolled in
        var links = document.querySelectorAll('.sb-item');
        links.forEach(function(link) {
          // v73aj: match by pathname only, ignoring ?as=X query string that
          // v73f appends across all sidebar links when admin is in partner
          // preview mode. Before this fix, badges silently never rendered
          // for ?as=X sessions because the equality check failed against
          // 'pp-conversations?as=gypsy-by-mekong-kingdoms' etc.
          var hrefPath = (link.getAttribute('href') || '').split('?')[0].replace(/\.html$/, '');
          if (hrefPath === 'pp-conversations') {
            var badge = link.querySelector('.sb-badge');
            if (badge) {
              if (unread > 0) {
                badge.textContent = unread;
                badge.style.display = '';
                if (hasLoop) badge.classList.add('sb-badge-has-loop');
                else badge.classList.remove('sb-badge-has-loop');
              } else {
                badge.style.display = 'none';
                badge.classList.remove('sb-badge-has-loop');
              }
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
        // v73y: badge counts only bookings that need partner action, not the
        // full list. Previously this showed all non-cancelled bookings, which
        // meant the number was always-on and noisy.
        //
        // v73ah: also count confirmed bookings the partner hasn't yet seen.
        // The Stripe webhook + sync-payment set seenByPartner=false on
        // confirmation. The flag clears when partner opens the booking
        // detail (POST /api/booking/mark-seen). This surfaces fresh
        // confirmations as actionable items \u2014 the partner needs to know
        // a new booking landed and review the details.
        //
        // Counted:
        //   1. New enquiries (status:'enquiry', no active_offer, no offer ever sent)
        //   2. Pending change requests (booking.pendingChangeRequest present)
        //   3. NEW: Newly confirmed bookings unseen by partner
        //      (status === 'confirmed' && seenByPartner !== true)
        // Not counted: offer_sent (waiting on guest), seen confirmed, cancelled
        var needsAction = (d.bookings || []).filter(function(b) {
          if (b.status === 'cancelled') return false;
          if (b.pendingChangeRequest) return true;
          if (b.status === 'enquiry' && !b.active_offer_id) return true;
          if (b.status === 'confirmed' && b.seenByPartner !== true) return true;
          return false;
        });
        var links = document.querySelectorAll('.sb-item');
        links.forEach(function(link) {
          // v73aj: match by pathname only — see updateConvBadge for context.
          var hrefPath = (link.getAttribute('href') || '').split('?')[0].replace(/\.html$/, '');
          if (hrefPath === 'pp-bookings') {
            var badge = link.querySelector('.sb-badge');
            if (badge) {
              if (needsAction.length > 0) { badge.textContent = needsAction.length; badge.style.display = ''; }
              else badge.style.display = 'none';
            }
          }
        });
      })
      .catch(function(){});
  }

  function init() {
    // v73f: preserve ?as=X across partner-portal navigation. If the current
    // URL has ?as=X, rewrite every `.sb-item` sidebar link to carry the same
    // param. Without this, clicking Conversations from /pp-bookings?as=gypsy
    // would drop you on /pp-conversations (back to nour-el-nil default).
    var asParam = new URLSearchParams(location.search).get('as');
    if (asParam) {
      var encoded = encodeURIComponent(asParam.trim());
      document.querySelectorAll('.sb-item').forEach(function(link) {
        var href = link.getAttribute('href');
        if (!href) return;
        // Only rewrite partner-portal internal links; skip external URLs and anchors
        if (href.indexOf('://') !== -1) return;
        if (href.charAt(0) === '#') return;
        // Strip any existing ?as= (avoid double-appending on re-runs)
        var clean = href.split('?')[0];
        link.setAttribute('href', clean + '?as=' + encoded);
      });
      // Also surface which partner we're viewing as — small banner so admin
      // doesn't forget. Inject once.
      if (!document.getElementById('pp-as-banner')) {
        var banner = document.createElement('div');
        banner.id = 'pp-as-banner';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;background:#fef3c7;border-bottom:1px solid #f59e0b;color:#92400e;font-family:Geist,sans-serif;font-size:12px;font-weight:500;padding:6px 16px;text-align:center;';
        banner.innerHTML = 'Viewing partner portal as <strong>' + asParam + '</strong> · <a href="?" style="color:#92400e;text-decoration:underline;">Switch back to default</a>';
        document.body.appendChild(banner);
        // Push page content down so the banner doesn't overlap
        document.body.style.paddingTop = '32px';
      }
    }

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
