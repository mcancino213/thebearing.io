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

/* ── v77e: Envoy enquiry handoff ──────────────────────────────────────
   The Envoy ends a ready-to-proceed reply with [[ENQUIRE:slug]] (prompt
   rule in envoy-prompt.js). This wrapper strips the marker from the
   rendered message and appends a real "Start your enquiry" card in the
   drawer. Wrapping window.ciAddMsg centrally (bearing.js is on every
   public page) covers all ~20 inline drawer copies + the shared module
   without touching them — no per-page drift. */
(function () {
  var tries = 0;
  function enquireHref(slug) {
    if (slug === 'nour-el-nil-x' || slug === 'nour-el-nil') return '/nour-el-nil.html?enquire=1';
    return '/property.html?slug=' + encodeURIComponent(slug) + '&enquire=1';
  }
  function wrap() {
    if (typeof window.ciAddMsg !== 'function') {
      if (++tries < 40) setTimeout(wrap, 250);
      return;
    }
    if (window.ciAddMsg.__tbEnquireWrapped) return;
    var orig = window.ciAddMsg;
    var wrapped = function (text, type) {
      var slug = null;
      if (type === 'ai' && typeof text === 'string') {
        var m = text.match(/\[\[ENQUIRE:([a-z0-9-]+)\]\]/i);
        if (m) {
          slug = m[1].toLowerCase();
          text = text.replace(/\s*\[\[ENQUIRE:[a-z0-9-]+\]\]\s*/gi, ' ').replace(/\s+$/, '').trim();
        }
      }
      var out = orig(text, type);
      if (slug) {
        try {
          var msgs = document.getElementById('ci-messages');
          if (msgs) {
            var card = document.createElement('a');
            card.className = 'ci-enquire-card';
            card.href = enquireHref(slug);
            card.innerHTML = '<span class="ci-enquire-kicker">✦ NO COMMITMENT · REPLY WITHIN 24H</span><span class="ci-enquire-cta">Start your enquiry →</span>';
            msgs.appendChild(card);
            msgs.scrollTop = msgs.scrollHeight;
          }
        } catch (e) {}
      }
      return out;
    };
    wrapped.__tbEnquireWrapped = true;
    window.ciAddMsg = wrapped;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wrap);
  else wrap();
})();
