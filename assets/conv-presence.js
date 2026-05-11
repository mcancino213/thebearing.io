// Shared presence + notification helpers for conversation pages

(function(window) {
  'use strict';

  // ── Favicon dot ──
  // Draws a red dot on the existing favicon for unread indication
  var origFaviconHref = null;
  var dotFaviconCache = null;

  function drawFaviconDot(show) {
    var link = document.querySelector("link[rel*='icon']") || document.createElement('link');
    link.type = 'image/x-icon';
    link.rel = 'shortcut icon';
    if (!origFaviconHref) origFaviconHref = link.href || '/favicon.ico';

    if (!show) {
      link.href = origFaviconHref;
      if (!link.parentNode) document.head.appendChild(link);
      return;
    }

    if (dotFaviconCache) {
      link.href = dotFaviconCache;
      if (!link.parentNode) document.head.appendChild(link);
      return;
    }

    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function() {
      var canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 32;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 32, 32);
      // Red dot in top-right
      ctx.beginPath();
      ctx.arc(24, 8, 7, 0, 2 * Math.PI);
      ctx.fillStyle = '#dc2626';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      try {
        dotFaviconCache = canvas.toDataURL('image/png');
        link.href = dotFaviconCache;
        if (!link.parentNode) document.head.appendChild(link);
      } catch(e) {
        // CORS or canvas tainted — fallback to a generated red dot only
        var c2 = document.createElement('canvas');
        c2.width = 32; c2.height = 32;
        var ctx2 = c2.getContext('2d');
        ctx2.fillStyle = '#dc2626';
        ctx2.beginPath();
        ctx2.arc(16, 16, 14, 0, 2 * Math.PI);
        ctx2.fill();
        dotFaviconCache = c2.toDataURL('image/png');
        link.href = dotFaviconCache;
        if (!link.parentNode) document.head.appendChild(link);
      }
    };
    img.onerror = function() {
      // Fallback: pure red dot favicon
      var c2 = document.createElement('canvas');
      c2.width = 32; c2.height = 32;
      var ctx2 = c2.getContext('2d');
      ctx2.fillStyle = '#dc2626';
      ctx2.beginPath();
      ctx2.arc(16, 16, 14, 0, 2 * Math.PI);
      ctx2.fill();
      dotFaviconCache = c2.toDataURL('image/png');
      link.href = dotFaviconCache;
      if (!link.parentNode) document.head.appendChild(link);
    };
    img.src = origFaviconHref;
  }

  // ── Title with unread count ──
  var origTitle = null;
  function setUnreadInTitle(count) {
    if (!origTitle) origTitle = document.title.replace(/^\(\d+\)\s*/, '');
    if (count > 0) {
      document.title = '(' + count + ') ' + origTitle;
    } else {
      document.title = origTitle;
    }
  }

  // ── Heartbeat (presence) ──
  var heartbeatInterval = null;
  function startHeartbeat(payload) {
    function ping() {
      fetch('/api/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(function(){});
    }
    ping();
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(ping, 30000);
  }
  function stopHeartbeat() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  }

  // ── Presence query ──
  function fetchPresence(params) {
    var qs = Object.keys(params).map(function(k){ return k + '=' + encodeURIComponent(params[k]); }).join('&');
    return fetch('/api/presence?' + qs).then(function(r){ return r.json(); });
  }

  // ── Last-seen humanize ──
  function timeAgo(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    var mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    if (days < 7) return days + 'd ago';
    return new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric'});
  }

  // ── Property local time ──
  function propertyLocalTime(timezone) {
    if (!timezone) return '';
    try {
      return new Date().toLocaleTimeString('en-US',{
        timeZone: timezone, hour:'numeric', minute:'2-digit', hour12: true
      });
    } catch(e) { return ''; }
  }

  // Page visibility — clear unread when user views page
  function onVisible(cb) {
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) cb();
    });
  }

  window.ConvPresence = {
    drawFaviconDot: drawFaviconDot,
    setUnreadInTitle: setUnreadInTitle,
    startHeartbeat: startHeartbeat,
    stopHeartbeat: stopHeartbeat,
    fetchPresence: fetchPresence,
    timeAgo: timeAgo,
    propertyLocalTime: propertyLocalTime,
    onVisible: onVisible
  };
})(window);
