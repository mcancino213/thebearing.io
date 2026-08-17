/* ═══════════════════════════════════════════════════════════════════
   THE BEARING — brand behavior layer (v75y)
   Pairs with assets/bearing.css. Dependency-free, safe on any page.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* Format {lat,lng} → "25.29°N 32.55°E". Returns '' for missing/invalid
     input so callers can render-nothing rather than render-wrong.
     (No dummy data: absent coordinates simply don't display.) */
  window.tbCoord = function (lat, lng) {
    var la = parseFloat(lat), lo = parseFloat(lng);
    if (!isFinite(la) || !isFinite(lo)) return '';
    if (la < -90 || la > 90 || lo < -180 || lo > 180) return '';
    return Math.abs(la).toFixed(2) + '\u00B0' + (la >= 0 ? 'N' : 'S') + ' '
         + Math.abs(lo).toFixed(2) + '\u00B0' + (lo >= 0 ? 'E' : 'W');
  };

  /* Build a coordinate element: pip + "LAT°N LNG°E — PLACE".
     Returns null when coords are absent (caller appends nothing). */
  window.tbCoordEl = function (lat, lng, place, onDark) {
    var txt = window.tbCoord(lat, lng);
    if (!txt) return null;
    var wrap = document.createElement('span');
    wrap.className = 'tb-coord' + (onDark ? ' on-dark' : '');
    var pip = document.createElement('i');
    pip.className = 'tb-coord-pip';
    wrap.appendChild(pip);
    wrap.appendChild(document.createTextNode(
      txt + (place ? ' \u2014 ' + String(place).toUpperCase() : '')));
    return wrap;
  };

  /* Quiet scroll reveals on the main content modules. */
  function initReveals() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!('IntersectionObserver' in window)) return;
    var targets = document.querySelectorAll('.module, .why-card, [data-tb-reveal]');
    if (!targets.length) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    targets.forEach(function (t) {
      /* Don't hide anything already in the viewport on load — no flash. */
      var r = t.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.9) return;
      t.classList.add('tb-reveal');
      io.observe(t);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReveals);
  } else {
    initReveals();
  }
})();
