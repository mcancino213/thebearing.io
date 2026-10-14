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

// ── v77h: shared rich voyage-card fragments ─────────────────────────────────
// The flagship's hand-written card carries a number, tagline, pull quote and
// a 4-stat strip; the dynamic KV cards on cruises/hotels/villas rendered only
// name + location (Miguel: "they're just plain"). One shared builder here so
// the three listing pages render the same richness and can't drift apart.
(function () {
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  window.tbVoyageRich = function (p) {
    p = p || {};
    var tagline = p.tagline || p.hook || (p.overview && p.overview.p1) || '';
    var q = (p.quote && p.quote.text) ? String(p.quote.text).replace(/^["“”\s]+|["“”\s]+$/g, '') : '';
    if (q.length > 220) q = q.substring(0, 220).trimEnd() + '…';
    var factHtml = q ? '<div class="voyage-fact">"' + esc(q) + '"</div>' : '';
    var stats = (p.render && Array.isArray(p.render.stats))
      ? p.render.stats.filter(function (s) { return s && (s.value || s.label); }).slice(0, 4) : [];
    var statsHtml = stats.length
      ? '<div class="voyage-stats">' + stats.map(function (s) {
          return '<div class="vstat"><div class="vstat-lbl">' + esc(s.label || '') + '</div><div class="vstat-val">' + esc(s.value || '') + '</div></div>';
        }).join('') + '</div>'
      : '';
    var durationHtml = (p.render && p.render.duration_tagline)
      ? '<span class="voyage-distance">' + esc(p.render.duration_tagline) + '</span>' : '';
    var exclusiveNote = null;
    if (p.pricing_model === 'exclusive' && p.exclusive && p.exclusive.price) {
      var ep = parseInt(String(p.exclusive.price).replace(/[^0-9]/g, ''), 10);
      if (isFinite(ep) && ep > 0) exclusiveNote = 'From $' + ep.toLocaleString() + ' / ' + (p.exclusive.per || 'night') + ' · whole property';
    }
    return { tagline: tagline, factHtml: factHtml, statsHtml: statsHtml, durationHtml: durationHtml, exclusiveNote: exclusiveNote };
  };
})();

// ── v77i: THE CHART SCALE — shared filter band (replaces the pills) ─────────
// tbScaleAttrs(p) derives filterable facts from a property record into data-
// attributes for a .voyage card; tbScale(mountSel, items) renders the band,
// counts matching cards live, and filters the stack on click. Hardcoded cards
// (the flagship) participate by carrying the same data- attributes in markup.
(function () {
  var GEO = {
    africa: ['kenya','namibia','botswana','egypt','tanzania','south africa','morocco','rwanda','uganda','zambia','zimbabwe','mozambique','seychelles','mauritius','madagascar','ethiopia'],
    europe: ['italy','france','spain','greece','portugal','united kingdom','uk','scotland','england','ireland','switzerland','austria','germany','norway','sweden','finland','iceland','croatia','montenegro','turkey'],
    asia: ['laos','indonesia','japan','thailand','vietnam','cambodia','myanmar','india','sri lanka','maldives','bhutan','nepal','philippines','malaysia','china','oman','jordan','uae'],
    americas: ['peru','usa','united states','mexico','brazil','argentina','chile','costa rica','ecuador','galapagos','colombia','canada','belize','panama','bolivia','uruguay']
  };
  function geoOf(country) {
    var c = String(country || '').toLowerCase().trim();
    if (!c) return '';
    for (var g in GEO) if (GEO[g].indexOf(c) > -1) return g;
    return '';
  }
  function catOf(type) {
    var t = String(type || '').toLowerCase();
    if (t.indexOf('expedition') > -1) return 'expedition';
    if (t.indexOf('river') > -1 || t.indexOf('dahabiya') > -1 || t.indexOf('houseboat') > -1) return 'river';
    if (t.indexOf('ocean') > -1 || t.indexOf('sea') > -1 || t.indexOf('yacht') > -1 || t.indexOf('sail') > -1 || t.indexOf('phinisi') > -1) return 'ocean';
    return '';
  }
  window.tbScaleAttrs = function (p) {
    p = p || {};
    var tags = (p.details && p.details.tags) || p.tags || [];
    var low = tags.map(function (t) { return String(t).toLowerCase(); });
    var guests = parseInt((p.details && p.details.max_guests) || p.maxg || '', 10);
    var price = parseInt(String((p.pricing_model === 'exclusive' && p.exclusive && p.exclusive.price) || p.price_from || '').replace(/[^0-9]/g, ''), 10);
    return ' data-f="1"' +
      ' data-fcat="' + catOf(p.type) + '"' +
      ' data-fgeo="' + geoOf(p.country) + '"' +
      (isFinite(guests) && guests > 0 ? ' data-fguests="' + guests + '"' : '') +
      (isFinite(price) && price > 0 ? ' data-fprice="' + price + '"' : '') +
      (low.indexOf('adults only') > -1 ? ' data-fadults="1"' : '') +
      ((low.indexOf('family-friendly') > -1 || low.indexOf('family') > -1) ? ' data-ffam="1"' : '') +
      (p.pricing_model === 'exclusive' ? ' data-fexcl="1"' : '');
  };
  window.tbScale = function (mountSel, items) {
    var active = 0;
    function dataOf(card) {
      var ds = card.dataset || {};
      return { cat: ds.fcat || '', geo: ds.fgeo || '', guests: parseInt(ds.fguests || '0', 10) || 0,
               price: parseInt(ds.fprice || '0', 10) || 0, adults: ds.fadults === '1', fam: ds.ffam === '1', excl: ds.fexcl === '1' };
    }
    function cards() { return [].slice.call(document.querySelectorAll('.voyage[data-f]')); }
    function wrapperOf(card) {
      var par = card.parentElement;
      return (par && par.querySelector('.voyage-divider') && par.children.length <= 2) ? par : card;
    }
    function render() {
      var mount = document.querySelector(mountSel);
      if (!mount) return;
      var cs = cards();
      mount.innerHTML = '';
      items.forEach(function (it, idx) {
        var n = idx === 0 ? cs.length : cs.filter(function (c) { return it.test(dataOf(c)); }).length;
        var a = document.createElement('a');
        a.href = '#';
        a.className = idx === active ? 'on' : '';
        if (idx === active) a.setAttribute('aria-current', 'true');
        a.innerHTML = '<em>' + (n > 0 ? ('0' + n).slice(-2) : '—') + '</em>' + it.label;
        a.onclick = function (e) {
          e.preventDefault();
          active = idx;
          cards().forEach(function (c) {
            var ok = idx === 0 || it.test(dataOf(c));
            wrapperOf(c).style.display = ok ? '' : 'none';
          });
          render();
        };
        mount.appendChild(a);
      });
    }
    render();
    window.__tbScaleRefresh = render;
  };
})();
