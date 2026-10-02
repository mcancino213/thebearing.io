/* THE BEARING — Envoy drawer (v76j shared module)
   Markup + behavior extracted verbatim from cruises.html. Requires
   /assets/envoy-prompt.js (window.CI_SYSTEM) loaded first and
   /assets/envoy-drawer.css linked. Injects the FAB + drawer at
   DOMContentLoaded. First consumer: villas.html; other pages keep
   their inline copies until migrated. */
(function(){
  function inject(){
    if (document.getElementById("ci-fab")) return; // never double-inject
    var host = document.createElement("div");
    host.innerHTML = '<button class="ci-fab" id="ci-fab" onclick="openEnvoy()">\n  <div class="ci-fab-pulse"></div>\n  <div class="ci-fab-txt">\n    <div class="ci-fab-label">The Envoy</div>\n    <div class="ci-fab-sub">Your Resident Expert</div>\n  </div>\n</button>\n<div class="ci-drawer" id="ci-drawer">\n\n  <div class="ci-head">\n    <div class="ci-avatar"><svg viewBox="0 0 16 16"><circle cx="8" cy="6" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg></div>\n    <div class="ci-head-txt">\n      <div class="ci-name">The Envoy</div>\n      <div class="ci-status"><div style="width:6px;height:6px;border-radius:50%;background:#4ade80;flex-shrink:0;"></div>Online · specialist in rare travel</div>\n    </div>\n    <button class="ci-close" onclick="closeEnvoy()"><svg viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg></button>\n  </div>\n\n  <div class="ci-context" id="ci-context">\n    <div class="ci-context-dot"></div>\n    <div class="ci-context-txt" id="ci-context-txt">Browsing The Bearing</div>\n  </div>\n\n  <div class="ci-messages" id="ci-messages"></div>\n\n  <div class="ci-sugs" id="ci-sugs">\n    <button class="ci-sug" onclick="ciAsk(this)">Something remote and untouched</button>\n    <button class="ci-sug" onclick="ciAsk(this)">Beach, total privacy, no schedule</button>\n    <button class="ci-sug" onclick="ciAsk(this)">Deeply cultural and historic</button>\n    <button class="ci-sug" onclick="ciAsk(this)">Surprise me entirely</button>\n  </div>\n\n  <div class="ci-input-row">\n    <input class="ci-input" id="ci-input" type="text" placeholder="Ask anything about travel…" onkeydown="if(event.key===\'Enter\')ciSend()">\n    <button class="ci-send" onclick="ciSend()"><svg viewBox="0 0 16 16"><line x1="3" y1="8" x2="13" y2="8"/><polyline points="9,4.5 13,8 9,11.5"/></svg></button>\n  </div>\n\n</div>';
    while (host.firstChild) document.body.appendChild(host.firstChild);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject); else inject();
})();

var ciOpen = false;
var ciBusy = false;

function ciLoadHistory() {
  try { return JSON.parse(sessionStorage.getItem('ci_history') || '[]'); } catch(e) { return []; }
}
function ciSaveHistory(h) {
  try { sessionStorage.setItem('ci_history', JSON.stringify(h)); } catch(e) {}
}

var ciHistory = ciLoadHistory();

function openEnvoy() {
  ciOpen = true;
  document.getElementById('ci-drawer').classList.add('open');
  var _fab = document.getElementById('ci-fab');
  if(_fab){ _fab.style.opacity='0'; _fab.style.transform='translateY(16px)'; setTimeout(function(){ _fab.style.display='none'; }, 280); }
  document.body.classList.add('ci-open');
  // Restore messages from history
  ciRestoreMessages();
  setTimeout(function(){ document.getElementById('ci-input').focus(); }, 400);
}

function closeEnvoy() {
  ciOpen = false;
  document.getElementById('ci-drawer').classList.remove('open');
  var _fab2 = document.getElementById('ci-fab');
  if(_fab2){ _fab2.style.display='flex'; setTimeout(function(){ _fab2.style.opacity='1'; _fab2.style.transform=''; }, 20); }
  document.body.classList.remove('ci-open');
}

function ciRestoreMessages() {
  var msgs = document.getElementById('ci-messages');
  msgs.innerHTML = '';
  if (ciHistory.length === 0) {
    // First time — show welcome
    ciAddMsg('Hello — I know every property in our collection personally. Tell me what you are dreaming of. A mood, a landscape, a feeling. I will find the place made for you.', 'ai');
  } else {
    var sugs = document.getElementById('ci-sugs');
    if (sugs) sugs.style.display = 'none';
    // Restore previous conversation (filter hidden context-switch messages)
    ciHistory.forEach(function(m) {
      if (m._type === 'context_switch' || m._type === 'context_switch_ack') return;
      ciAddMsg(m.content, m.role === 'user' ? 'user' : 'ai');
      if (m._cards && m._cards.length > 0) ciAddPropertyCards(m._cards);
    });
  }
  msgs.scrollTop = msgs.scrollHeight;
}

// Update context pill based on current page
(function() {
  var path = window.location.pathname;
  var params = new URLSearchParams(window.location.search);
  var slug = params.get('slug');
  var ctx = 'Browsing The Bearing';
  if (slug) {
    var name = slug.replace(/-/g, ' ').replace(/\b\w/g, function(c){ return c.toUpperCase(); });
    ctx = 'Viewing: ' + name;
  } else {
    // Flagship property page — derive from filename
    var pageName = path.split('/').pop().replace('.html','');
    var nonPropertyPages = ['index','property','404','about','hotels','cruises','villas','collections','journal','how-we-choose','founding-member','the-bearing','the-envoy','vibe-search','search','bookings','saved','lens','preferences','settings','my-account','channels','vibe-search'];
    if (pageName && nonPropertyPages.indexOf(pageName) === -1) {
      var name = pageName.replace(/-/g, ' ').replace(/\b\w/g, function(c){ return c.toUpperCase(); });
      ctx = 'Viewing: ' + name;
    }
  }
  var el = document.getElementById('ci-context-txt');
  if (el) el.textContent = ctx;
  // Also update when propData loads (gets proper name from KV)
  var orig = window.renderProperty;
  window._ciContextSlug = slug;
})();

function ciAsk(btn) {
  document.getElementById('ci-sugs').style.display = 'none';
  ciSendMsg(btn.textContent.trim());
}

function ciSend() {
  var inp = document.getElementById('ci-input');
  var q = inp.value.trim();
  if (!q || ciBusy) return;
  inp.value = '';
  document.getElementById('ci-sugs').style.display = 'none';
  ciSendMsg(q);
}


var CI_PROPERTIES = {
  'nour el nil':        { slug:'nour-el-nil',         label:'Nour El Nil',         loc:'Nile River Cruise · Egypt',       rating:5, img:'https://images.unsplash.com/photo-1528360983277-13d401cdc186?w=600&q=80&fit=crop' },
};

function ciDetectProperties(text) {
  var lower = text.toLowerCase();
  var found = [], seen = {};
  Object.keys(CI_PROPERTIES).forEach(function(key) {
    if (lower.indexOf(key) > -1 && !seen[key]) { seen[key] = true; found.push(CI_PROPERTIES[key]); }
  });
  return found;
}

function ciAddPropertyCards(props) {
  if (!props || props.length === 0) return;
  var msgs = document.getElementById('ci-messages');
  var row = document.createElement('div');
  row.className = 'ci-prop-cards';
  props.forEach(function(p) {
    var href = (location.hostname === 'thebearing.io' || location.hostname.endsWith('.workers.dev'))
      ? '/property.html?slug=' + p.slug : '/property.html?slug=' + p.slug;
    var stars = p.rating ? '\u2605'.repeat(p.rating) : '';
    var a = document.createElement('a');
    a.className = 'ci-prop-card';
    a.href = href;
    var img = document.createElement('img');
    img.src = p.img; img.alt = p.label; img.loading = 'lazy';
    img.onerror = function(){ this.style.display='none'; };
    var body = document.createElement('div');
    body.className = 'ci-prop-card-body';
    var nm = document.createElement('span');
    nm.className = 'ci-prop-card-name'; nm.textContent = p.label;
    var lc = document.createElement('span');
    lc.className = 'ci-prop-card-loc'; lc.textContent = p.loc;
    body.appendChild(nm); body.appendChild(lc);
    if (stars) {
      var st = document.createElement('span');
      st.className = 'ci-prop-card-stars'; st.textContent = stars;
      body.appendChild(st);
    }
    a.appendChild(img); a.appendChild(body); row.appendChild(a);
  });
  msgs.appendChild(row); msgs.scrollTop = msgs.scrollHeight;
}

async function ciSendMsg(text) {
  ciAddMsg(text, 'user');
  ciHistory.push({ role: 'user', content: text });
  ciSaveHistory(ciHistory);

  ciBusy = true;
  var t = ciShowTyping();

  try {
    var CI_API = '/api/envoy' /* v76h: same-origin always — the direct-API branch had no key and could never succeed; it broke www + preview domains */;
    // Strip metadata fields before sending to API
    var apiMessages = ciHistory.map(function(m) {
      return { role: m.role, content: m.content };
    });
    var res = await fetch(CI_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, system: CI_SYSTEM, messages: apiMessages })
    });
    var data = await res.json();
    if (data.error) { console.error('[Envoy] API error:', data.error); }
    var reply = (data.content && data.content[0] && data.content[0].text) || 'I lost my connection briefly — please try again.';
    t.remove();
    ciBusy = false;
    ciAddMsg(reply, 'ai');
    ciHistory.push({ role: 'assistant', content: reply });
    ciSaveHistory(ciHistory);
    var detectedProps = ciDetectProperties(reply);
    if (detectedProps.length > 0) ciAddPropertyCards(detectedProps);
  } catch(e) {
    t.remove();
    ciBusy = false;
    ciAddMsg('Something went wrong — please try again.', 'ai');
  }
}

function ciAddMsg(text, type) {
  var msgs = document.getElementById('ci-messages');
  var div = document.createElement('div');
  div.className = 'ci-msg ' + type;
  text.split('\n').filter(function(p){ return p.trim(); }).forEach(function(p, i) {
    var el = document.createElement('p');
    el.textContent = p.trim();
    if (i > 0) el.style.marginTop = '5px';
    div.appendChild(el);
  });
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function ciShowTyping() {
  var msgs = document.getElementById('ci-messages');
  var d = document.createElement('div');
  d.className = 'ci-typing-msg';
  d.innerHTML = '<span></span><span></span><span></span>';
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
  return d;
}

// Restore open state if user navigated while drawer was open
if (sessionStorage.getItem('ci_was_open') === '1') {
  // Small delay to let page render
  setTimeout(openEnvoy, 100);
}
window.addEventListener('beforeunload', function() {
  sessionStorage.setItem('ci_was_open', ciOpen ? '1' : '0');
});

