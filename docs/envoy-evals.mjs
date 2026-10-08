#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// THE ENVOY — EVAL HARNESS (v77e)
//
//   node docs/envoy-evals.mjs https://thebearing.io
//   node docs/envoy-evals.mjs            (defaults to https://thebearing.io)
//
// What it does:
//   1. Downloads the DEPLOYED assets/envoy-prompt.js from the target site and
//      executes it in a Node vm with a browser shim — so the system prompt
//      under test is exactly what real visitors get, live KV collection
//      splice included.
//   2. Pulls the property catalog to learn which slugs are Live / Coming soon
//      vs Draft (drafts must never leak into replies).
//   3. Runs a battery of questions through the REAL /api/envoy worker with
//      that system prompt and asserts on the replies.
//
// Checks:
//   FAIL  — invented/fake properties (the pre-v76 hallucination list),
//           draft-property leaks, missing price when one is on record.
//   WARN  — soft expectations (phrasing of honest refusals, enquiry marker)
//           where the model has legitimate discretion.
//
// Exit code 1 if anything FAILs — safe for CI.
// Each run costs ~8 live model calls; don't loop it.
// ─────────────────────────────────────────────────────────────────────────────

import vm from 'node:vm';

const BASE = (process.argv[2] || 'https://thebearing.io').replace(/\/+$/, '');
const MODEL = 'claude-sonnet-4-6';

// Properties the Envoy used to invent before the collection went live-spliced.
// Any of these in a reply is an instant FAIL.
const FAKE_PROPERTIES = [
  'Amangiri', 'Soneva Fushi', 'Capella Ubud', 'Singita',
  'Mekong Navigator', 'Al Moudira', 'La Maison Bleue',
];

const abs = (u) => (u.startsWith('http') ? u : BASE + u);

// ── 1. Execute the deployed prompt builder in a browser shim ────────────────
async function buildSystemPrompt() {
  const res = await fetch(abs('/assets/envoy-prompt.js'));
  if (!res.ok) throw new Error('could not fetch envoy-prompt.js: ' + res.status);
  const src = await res.text();

  const windowShim = {};
  const ctx = {
    window: windowShim,
    fetch: (u, o) => fetch(abs(String(u)), o),
    setTimeout, clearTimeout,
    console: { log: () => {}, error: () => {}, warn: () => {} },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'envoy-prompt.js' });

  // The builder fetches the catalog + every record, then splices. Wait for it.
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (Array.isArray(windowShim.__tbLiveCollection)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  // Give the apply-retry loop one beat to land the splice.
  await new Promise((r) => setTimeout(r, 500));

  if (typeof windowShim.CI_SYSTEM !== 'string') throw new Error('CI_SYSTEM never materialised');
  return {
    system: windowShim.CI_SYSTEM,
    liveSlugs: windowShim.__tbLiveCollection || [],
    spliced: Array.isArray(windowShim.__tbLiveCollection),
  };
}

// ── 2. Catalog: which slugs are drafts (must never appear in replies) ──────
async function fetchCatalog() {
  const cat = await (await fetch(abs('/api/property'))).json().catch(() => null);
  const slugs = ((cat && cat.slugs) || []).filter((s) => !s.startsWith('__'));
  const rows = await Promise.all(slugs.map(async (sl) => {
    try {
      const r = await (await fetch(abs('/api/property?slug=' + encodeURIComponent(sl)))).json();
      return r && r.data ? { slug: sl, p: r.data } : null;
    } catch { return null; }
  }));
  const live = [], drafts = [];
  for (const row of rows) {
    if (!row) continue;
    const st = String(row.p.status || '').toLowerCase();
    (st === 'live' || st === 'coming-soon' ? live : drafts).push(row);
  }
  return { live, drafts };
}

// ── 3. Ask the real worker ──────────────────────────────────────────────────
async function ask(system, question) {
  const res = await fetch(abs('/api/envoy'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 600, system,
      messages: [{ role: 'user', content: question }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error('worker error: ' + JSON.stringify(data.error).slice(0, 200));
  return (data.content && data.content[0] && data.content[0].text) || '';
}

// ── 4. The battery ───────────────────────────────────────────────────────────
function buildCases({ live, drafts }) {
  const liveNames = live.map((r) => (r.slug === 'nour-el-nil-x' ? 'Nour El Nil' : (r.p.name || r.slug)));
  const draftNames = drafts.map((r) => r.p.name).filter(Boolean);
  const draftSlugs = drafts.map((r) => r.slug);

  // Universal checks applied to EVERY reply.
  const universal = (reply, add) => {
    for (const fake of FAKE_PROPERTIES) {
      if (reply.toLowerCase().includes(fake.toLowerCase()))
        add('FAIL', `invented property "${fake}" in reply`);
    }
    for (const dn of draftNames) {
      if (dn.length > 3 && reply.toLowerCase().includes(dn.toLowerCase()))
        add('FAIL', `DRAFT property "${dn}" leaked into reply`);
    }
    for (const ds of draftSlugs) {
      if (reply.toLowerCase().includes(ds.toLowerCase()))
        add('FAIL', `draft slug "${ds}" leaked into reply`);
    }
  };

  const arijiju = live.find((r) => r.slug === 'arijiju');

  const cases = [
    {
      name: 'Africa recommendation names real live properties',
      q: 'I want somewhere extraordinary in Africa — remote, private. What do you have?',
      check(reply, add) {
        const mentionsLive = liveNames.some((n) => reply.toLowerCase().includes(n.toLowerCase()));
        if (!mentionsLive) add('FAIL', 'reply names no live property at all');
        if (arijiju && !reply.toLowerCase().includes('arijiju'))
          add('WARN', 'Arijiju is live but was not mentioned for an Africa ask');
      },
    },
    {
      name: 'Morocco honesty — no invented Bearing property',
      q: 'Do you have anything in Morocco? A riad in Marrakech maybe?',
      check(reply, add) {
        const honest = /\b(don'?t|do not|not currently|no (propert|place)|not (yet )?have|nothing (in|there))\b/i.test(reply);
        if (!honest) add('WARN', 'no clear honest-refusal phrasing detected — read the reply');
        if (/\bour\b.{0,40}\b(riad|marrakech|morocc)/i.test(reply))
          add('FAIL', 'reply appears to claim a Bearing property in Morocco');
      },
    },
    {
      name: 'Japan honesty — out-of-collection decline',
      q: 'What do you recommend in Japan?',
      check(reply, add) {
        const honest = /\b(don'?t|do not|not currently|no (propert|place)|not (yet )?have)\b/i.test(reply);
        if (!honest) add('WARN', 'no clear honest-refusal phrasing detected — read the reply');
      },
    },
    {
      name: 'Collection overview stays inside the list',
      q: 'Give me a quick tour of everything The Bearing offers right now.',
      check(reply, add) {
        const hits = liveNames.filter((n) => reply.toLowerCase().includes(n.toLowerCase()));
        if (hits.length < Math.min(2, liveNames.length))
          add('WARN', `only ${hits.length}/${liveNames.length} live properties mentioned in overview`);
      },
    },
  ];

  if (arijiju) {
    const px = arijiju.p.exclusive && arijiju.p.exclusive.price;
    cases.push({
      name: 'Arijiju price — quotes the on-record rate as guidance',
      q: 'Roughly what does Arijiju cost per night for the whole house?',
      check(reply, add) {
        if (!/\$\s?[\d][\d,]{2,}/.test(reply))
          add('FAIL', 'no dollar figure in reply despite a rate being on record');
        else if (px && !reply.replace(/,/g, '').includes(String(px).replace(/,/g, '')))
          add('WARN', `reply quotes a figure but not the recorded $${px}`);
      },
    });
    cases.push({
      name: 'Enquiry handoff — emits [[ENQUIRE:slug]] on clear intent',
      q: "Arijiju sounds perfect. We're ready — how do we start the booking?",
      check(reply, add) {
        const m = reply.match(/\[\[ENQUIRE:([a-z0-9-]+)\]\]/i);
        if (!m) add('WARN', 'no [[ENQUIRE:]] marker on a clear-intent ask (model discretion, but check)');
        else if (m[1].toLowerCase() !== 'arijiju') add('FAIL', `marker names wrong slug "${m[1]}"`);
      },
    });
  }

  cases.push({
    name: 'Flagship still first-class',
    q: 'Tell me about sailing the Nile with you.',
    check(reply, add) {
      if (!/nour el nil/i.test(reply)) add('WARN', 'Nour El Nil not named on a Nile ask');
    },
  });

  return { cases, universal };
}

// ── 5. Run ───────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
(async () => {
  console.log(`\nTHE ENVOY · EVALS  —  target: ${BASE}\n`);

  const { system, liveSlugs, spliced } = await buildSystemPrompt();
  const catalog = await fetchCatalog();
  console.log(`prompt: ${system.length} chars · live splice: ${spliced ? 'YES (' + liveSlugs.join(', ') + ')' : 'NO — static fallback'}`);
  console.log(`catalog: ${catalog.live.length} live/coming-soon, ${catalog.drafts.length} draft\n`);
  if (!spliced) console.log('⚠ collection splice did not run — evals test the static fallback prompt\n');

  const { cases, universal } = buildCases(catalog);
  const results = [];

  for (const c of cases) {
    const notes = [];
    const add = (lvl, msg) => notes.push({ lvl, msg });
    let reply = '';
    try {
      reply = await ask(system, c.q);
      universal(reply, add);
      c.check(reply, add);
    } catch (e) {
      add('FAIL', 'request failed: ' + e.message);
    }
    const worst = notes.some((n) => n.lvl === 'FAIL') ? 'FAIL' : notes.some((n) => n.lvl === 'WARN') ? 'WARN' : 'PASS';
    results.push({ name: c.name, worst, notes, reply });
    const icon = worst === 'PASS' ? '✓' : worst === 'WARN' ? '△' : '✗';
    console.log(`${icon} ${pad(worst, 5)} ${c.name}`);
    for (const n of notes) console.log(`        · ${n.lvl}: ${n.msg}`);
    if (worst !== 'PASS') console.log(`        reply: ${reply.replace(/\s+/g, ' ').slice(0, 220)}…`);
    await new Promise((r) => setTimeout(r, 800)); // be gentle on the worker
  }

  const fails = results.filter((r) => r.worst === 'FAIL').length;
  const warns = results.filter((r) => r.worst === 'WARN').length;
  console.log(`\n${results.length} cases · ${results.length - fails - warns} pass · ${warns} warn · ${fails} fail\n`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(2); });
