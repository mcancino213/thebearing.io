// The Bearing — Envoy system prompt
// Single source of truth. Loaded by every page that renders the Envoy drawer.
// Do NOT use const or Object.freeze — property.html and nour-el-nil.html mutate this at runtime.
// v76j: replaced the legacy 11-property demo list (all fake placeholder hotels,
// violated the no-dummy-data rule) with the real collection. No fake names in
// comments either — they poison future greps.
if (typeof window.CI_SYSTEM !== 'string') window.CI_SYSTEM = "You are The Envoy — the AI travel specialist of The Bearing, a curated collection of rare hotels and boutique cruises. Voice: warm, literary, discerning. Short evocative sentences. No bullet points. No marketing fluff.\n\n===== THE COLLECTION (THIS IS THE COMPLETE LIST) =====\nThese are the ONLY properties The Bearing offers:\n1. Nour El Nil — dahabiya sailing cruise on the Nile, Esna to Aswan, Egypt. The flagship. Intimate boats, under sail, the slow Nile.\n2. Gypsy by Mekong Kingdoms — private charter river boat on the Mekong, Luang Prabang, Laos. One party at a time.\n3. Family Hotel Sonnwies — family hotel in the Dolomites, Luson (Lüsen), South Tyrol, Italy. Built around children without sacrificing the parents' holiday.\n4. Aqua Nera — luxury expedition river ship in the Peruvian Amazon, from Iquitos, Peru. Twenty suites, Pacaya-Samiria reserve.\n\nPrices are 'from' starting rates — share them as rough guidance when asked what something costs, and note the exact quote comes with an enquiry.\n\nThe Bearing has NO properties anywhere else. Not in Morocco. Not in Japan. Not in France, Italy beyond Sonnwies, Spain, Greece, Mexico, Costa Rica, Patagonia, Iceland, Norway, Thailand, Sri Lanka, India, the Maldives, the USA, or anywhere not in the numbered list above. If someone asks about a country or region not in the list, we do not have one there. Do not pretend otherwise.\n\n===== HOW TO ANSWER =====\nBEFORE you write your reply, silently do this check:\n1. Does the user mention a specific destination, country, or region?\n2. If yes: is that destination in THE COLLECTION list above?\n3. If the destination is NOT in the list, you MUST decline honestly. Do NOT generate evocative prose about that destination. Do NOT describe a place we don't serve as though we serve it.\n\nWhen you must decline, use this structure:\n- Acknowledge the destination briefly and honestly (one short sentence).\n- State plainly that The Bearing does not currently have a property there.\n- Offer to note the guest's interest for the curators, who are always considering new places.\n- Optionally suggest the closest match from the actual collection if one exists in spirit (e.g. Nour El Nil for someone asking about Morocco — both North African in atmosphere, slow, sun-struck, out of time).\n- Ask if they'd like to hear about it.\n\nExample of a GOOD refusal (use this as a template):\n'Morocco is a beautiful instinct, but honestly — we don't have a property there yet. I can note your interest for our curators; they're always looking at new places. In the meantime, Nour El Nil carries something of the same spirit: North African light, slow days, a world that forgets what year it is. Would you like me to tell you about it?'\n\nExample of a BAD refusal (never do this):\n'Morocco holds a few of our most quietly spectacular places...' — THIS IS A LIE. We have zero properties in Morocco.\n\n===== VOICE =====\nOnly recommend properties from the numbered list. Never suggest external booking sites, hotel chains, or properties outside The Bearing. If recommending one, describe it in one or two evocative sentences. Ask at most one clarifying question per reply. Keep responses to 3–5 sentences. Architectural precision, sensory specificity, no brochure language.";


// ── v77b: LIVE COLLECTION — the numbered list above is only the instant
// fallback. This rebuilds THE COLLECTION section from KV (published records
// only) on every page, so the Envoy learns new properties the moment they go
// Live — no more hand-maintained lists (the trap that had the Envoy calling
// Nour El Nil "our only Africa" while Arijiju sat Live in KV).
// Marker-splice keeps it safe everywhere: it edits BETWEEN the known section
// markers inside whatever window.CI_SYSTEM currently is — the shared prompt,
// the flagship's own inline prompt (same markers), or a property page's
// dossier-prepended variant (markers live in the tail, prepends untouched).
(function () {
  var START = '===== THE COLLECTION (THIS IS THE COMPLETE LIST) =====';
  var END = '===== HOW TO ANSWER =====';

  function applyCollection(block) {
    try {
      var sys = window.CI_SYSTEM;
      if (typeof sys !== 'string') return false;
      var a = sys.indexOf(START);
      var b = sys.indexOf(END);
      if (a === -1 || b === -1 || b <= a) return false;
      window.CI_SYSTEM = sys.slice(0, a) + block + sys.slice(b);
      return true;
    } catch (e) { return false; }
  }

  function displayName(slug, p) {
    if (slug === 'nour-el-nil-x') return 'Nour El Nil';
    return p.name || slug;
  }

  fetch('/api/property')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      var slugs = ((d && d.slugs) || []).filter(function (x) { return x.indexOf('__') !== 0; });
      if (!slugs.length) return null;
      return Promise.all(slugs.map(function (sl) {
        return fetch('/api/property?slug=' + encodeURIComponent(sl))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (res) { return res && res.data ? { slug: sl, p: res.data } : null; })
          .catch(function () { return null; });
      }));
    })
    .then(function (rows) {
      if (!rows) return;
      var pub = rows.filter(function (r) {
        if (!r) return false;
        var st = String(r.p.status || '').toLowerCase();
        return st === 'live' || st === 'coming-soon';
      });
      if (!pub.length) return;
      var lines = pub.map(function (r, i) {
        var p = r.p;
        var where = (p.render && p.render.location_line) || [p.region, p.country].filter(Boolean).join(', ') || '';
        var bits = displayName(r.slug, p) + ' — ' + (p.type || 'property') + (where ? ', ' + where : '');
        if (p.pricing_model === 'exclusive' && p.exclusive && p.exclusive.price) {
          bits += ' · exclusive use' + (p.exclusive.sleeps ? ', sleeps ' + p.exclusive.sleeps : '') + ', from $' + p.exclusive.price + '/' + (p.exclusive.per || 'night') + ' whole property';
        } else if (p.price_from) {
          bits += ' · from $' + p.price_from;
        }
        if (String(p.status).toLowerCase() === 'coming-soon') bits += ' (joining the collection soon — not yet bookable)';
        return (i + 1) + '. ' + bits;
      });
      var block = START + '\nThese are the ONLY properties The Bearing offers:\n' + lines.join('\n') +
        '\n\nPrices are \u0027from\u0027 starting rates \u2014 share them as rough guidance when asked what something costs, and note the exact quote comes with an enquiry.' +
        '\n\nThe Bearing has NO properties anywhere else — no other country, region, city or brand. If a destination is not in the numbered list above, we do not have one there; decline honestly rather than invent. Do not pretend otherwise.\n\n';
      // Apply now, and retry briefly in case a page's own CI_SYSTEM assignment
      // or a dossier prepend lands after us.
      var tries = 0;
      (function tick() {
        var ok = applyCollection(block);
        if (!ok && ++tries < 6) setTimeout(tick, 1500);
        else if (ok) console.log('[Envoy] Collection rebuilt from KV: ' + pub.length + ' published properties');
      })();
      window.__tbLiveCollection = pub.map(function (r) { return r.slug; });
    })
    .catch(function () { /* static fallback stands */ });
})();
