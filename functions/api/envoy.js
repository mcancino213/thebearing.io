// TheBearing.io Worker — handles these endpoints:
//   /api/envoy   POST → proxies to Anthropic API with secret key
//   /api/dossier GET  → reads a property dossier from KV by ?slug=
//   /api/dossier POST → writes a property dossier to KV
//   /api/itinerary GET  → reads an itinerary from KV by ?slug= (returns JSON object)
//   /api/itinerary POST → writes an itinerary JSON object to KV under {slug}:itinerary
//   /api/source  POST → fetches a URL, strips HTML, caches in KV under {slug}:source:{n}
//   /api/source  GET  → returns all cached sources for a slug
//   /api/source  DELETE → removes a cached source
//   /api/upload  POST → gets a Cloudflare Images direct-upload URL, then browser uploads
//                       directly; returns { url } delivery URL ready to paste
//   /api/property GET/POST/DELETE → full property data save/load/delete/list
//   /api/stripe/health  GET (admin) → reports whether Stripe is configured and reachable
//   /api/stripe/webhook POST (public) → receives Stripe events, signature-verified
// All other paths fall through to static asset serving.

// Stripe SDK: configured to use FetchHttpClient because Cloudflare Workers has no
// node:https. The default SDK HTTP client would fail to load on Pages Functions.
// See https://github.com/stripe/stripe-node — the README has a Cloudflare section.
import Stripe from 'stripe';

const CF_ACCOUNT_ID = 'd62dd7db798247bb6cc9ff18ff7ee84f';
const CF_ACCOUNT_HASH = 'YyCqpmHo4EG6ShyDMCRcVQ';

// Lazy-init a Stripe client. Returns null when STRIPE_SECRET_KEY is not configured
// so callers can return a sensible "not configured" response instead of crashing.
// Module-cached because each Pages Function invocation is short-lived but may make
// multiple Stripe calls — no point reconstructing the client per call.
let _stripeClient = null;
let _stripeClientKey = null;
function getStripe(env) {
  const key = env && env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (_stripeClient && _stripeClientKey === key) return _stripeClient;
  _stripeClient = new Stripe(key, {
    // Workers don't have node:https; force the fetch-based HTTP client.
    httpClient: Stripe.createFetchHttpClient(),
    // Pin the API version so behavior is stable even as Stripe rolls forward.
    apiVersion: '2025-04-30.basil',
    // Tag requests so we can find them in Stripe logs.
    appInfo: { name: 'TheBearing.io', version: '1.0' },
  });
  _stripeClientKey = key;
  return _stripeClient;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS preflight ────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Email, X-Clerk-Session'
        }
      });
    }

    // ── Admin auth helper ─────────────────────────────────────────
    // Verifies the request comes from an authorized admin user.
    // Strategy: client sends Clerk session token in X-Clerk-Session header.
    // We verify it against Clerk's API to get the user's email, then check the allowlist.
    // Falls back to X-Admin-Email header check (less secure) for environments without session tokens.
    //
    // The allowlist is the union of:
    //   1. ADMIN_EMAILS_BASELINE — hardcoded founder address, never removable via UI (failsafe)
    //   2. KV-stored allowlist at __settings:allowlist — managed via admin-settings.html
    const ADMIN_EMAILS_BASELINE = ['admin@thebearing.io'];

    async function getAllowlist() {
      const extras = await loadAllowlistExtras(env);
      const merged = ADMIN_EMAILS_BASELINE.concat(extras);
      // dedupe + lowercase
      const seen = {};
      const out = [];
      merged.forEach(function(e) {
        const lc = String(e || '').toLowerCase().trim();
        if (lc && !seen[lc]) { seen[lc] = 1; out.push(lc); }
      });
      return out;
    }

    async function isAdmin() {
      const allowlist = await getAllowlist();
      const emailHeader = request.headers.get('X-Admin-Email');
      const sessionToken = request.headers.get('X-Clerk-Session');

      // Path 1: Clerk session token (most secure). If verification succeeds AND the
      // user's emails include an allowlisted address, accept. ANY other outcome
      // (token missing, secret missing, Clerk API error, email mismatch) falls
      // through to Path 2 instead of returning false outright — so a misconfigured
      // CLERK_SECRET_KEY can't poison auth for legitimate users.
      if (sessionToken && env.CLERK_SECRET_KEY) {
        try {
          const verifyResp = await fetch('https://api.clerk.com/v1/sessions/' + sessionToken + '/tokens', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + env.CLERK_SECRET_KEY }
          });
          if (verifyResp.ok) {
            const sessionData = await verifyResp.json();
            if (sessionData.user_id) {
              const userResp = await fetch('https://api.clerk.com/v1/users/' + sessionData.user_id, {
                headers: { 'Authorization': 'Bearer ' + env.CLERK_SECRET_KEY }
              });
              if (userResp.ok) {
                const user = await userResp.json();
                const emails = (user.email_addresses || []).map(function(e) { return (e.email_address || '').toLowerCase(); });
                if (emails.some(function(em) { return allowlist.indexOf(em) !== -1; })) {
                  return true;
                }
                console.log('[Admin] Clerk path: user emails not in allowlist. emails=', emails.join(','), 'allowlist=', allowlist.join(','));
              } else {
                console.log('[Admin] Clerk path: user fetch failed:', userResp.status);
              }
            } else {
              console.log('[Admin] Clerk path: no user_id in session response (expected for /sessions/{sid}/tokens — endpoint returns a JWT, not user info)');
            }
          } else {
            console.log('[Admin] Clerk path: token verify failed:', verifyResp.status);
          }
        } catch(e) { console.log('[Admin] Clerk verify exception:', e.message); }
      }

      // Path 2: Email header fallback. Always runs if Path 1 didn't return true.
      // admin-fetch.js sends ALL the user's emails as a comma-separated list
      // (primary + secondaries), so accounts with a non-admin primary email but
      // an admin secondary (e.g. gmail primary + admin@thebearing.io secondary)
      // are still recognised. Less secure than session-token verification but
      // raises the bar past random guessing.
      if (emailHeader) {
        const candidates = emailHeader.split(',').map(function(s) {
          return s.toLowerCase().trim();
        }).filter(Boolean);
        const matched = candidates.find(function(em) { return allowlist.indexOf(em) !== -1; });
        if (matched) return true;
        console.log('[Admin] Email header path: no candidate in allowlist. candidates=', candidates.join('|'), 'allowlist=', allowlist.join('|'));
        return false;
      }

      console.log('[Admin] No auth headers present');
      return false;
    }

    function adminDenied() {
      return jsonResponse({ error: 'admin access required' }, 403);
    }

    // ── /api/envoy — Anthropic API proxy (RAG-enhanced) ──────────
    if (url.pathname === '/api/envoy') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }

      let bodyText = await request.text();

      // RAG: if VECTORIZE and AI are bound, embed the last user message
      // and inject the top matching chunks into the system prompt
      if (env.VECTORIZE && env.AI) {
        try {
          const bodyObj = JSON.parse(bodyText);
          const messages = bodyObj.messages || [];

          // Find the last user message
          const lastUser = [...messages].reverse().find(m => m.role === 'user');
          const query = lastUser
            ? (typeof lastUser.content === 'string'
                ? lastUser.content
                : (lastUser.content || []).filter(b => b.type === 'text').map(b => b.text).join(' '))
            : '';

          if (query.trim().length > 10) {
            // Embed the query using Workers AI
            const embedRes = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
              text: [query.trim()]
            });
            const queryVector = embedRes.data[0];

            // Query Vectorize for top 4 matching chunks
            const vectorRes = await env.VECTORIZE.query(queryVector, {
              topK: 4,
              returnMetadata: 'all'
            });

            const chunks = (vectorRes.matches || [])
              .filter(m => m.score > 0.5)
              .map(m => m.metadata && m.metadata.text ? m.metadata.text : null)
              .filter(Boolean);

            if (chunks.length > 0) {
              const ragContext = '\n\n---\nRELEVANT KNOWLEDGE BASE:\n' +
                chunks.map((c, i) => `[${i + 1}] ${c}`).join('\n\n') +
                '\n---\n';

              // Inject into system prompt
              if (bodyObj.system) {
                if (typeof bodyObj.system === 'string') {
                  bodyObj.system = bodyObj.system + ragContext;
                } else if (Array.isArray(bodyObj.system)) {
                  const lastText = [...bodyObj.system].reverse().find(b => b.type === 'text');
                  if (lastText) lastText.text += ragContext;
                }
              } else {
                bodyObj.system = ragContext;
              }
              bodyText = JSON.stringify(bodyObj);
            }
          }
        } catch (e) {
          // RAG failure is non-fatal — continue with original body
          console.error('[RAG] error:', e.message);
        }
      }

      const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: bodyText
      });
      return new Response(anthropicResponse.body, {
        status: anthropicResponse.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // ── /api/index — embed + upsert content into Vectorize ────────
    // POST { slug, chunks: [{id, text}] } → embeds and upserts vectors
    // Used by admin-vectorize.html to index property content
    if (url.pathname === '/api/index') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }
      if (!env.VECTORIZE || !env.AI) {
        return jsonResponse({ error: 'VECTORIZE or AI binding not configured' }, 500);
      }

      let body;
      try { body = await request.json(); }
      catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }

      const { slug, chunks } = body;
      if (!slug || !Array.isArray(chunks) || chunks.length === 0) {
        return jsonResponse({ error: 'slug and chunks[] required' }, 400);
      }

      // Embed all chunks in one batch (max 100)
      const texts = chunks.map(c => c.text);
      const embedRes = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: texts });
      const vectors = embedRes.data;

      // Build Vectorize upsert payload
      const upsertVectors = vectors.map((vec, i) => ({
        id: `${slug}::${chunks[i].id}`,
        values: vec,
        metadata: {
          slug,
          chunkId: chunks[i].id,
          text: chunks[i].text.substring(0, 1000) // metadata limit
        }
      }));

      await env.VECTORIZE.upsert(upsertVectors);

      // Track indexed slugs in KV
      const indexedRaw = await env.DOSSIERS.get('__vectorized_slugs');
      let indexedSlugs = indexedRaw ? JSON.parse(indexedRaw) : [];
      if (!indexedSlugs.includes(slug)) {
        indexedSlugs.push(slug);
        await env.DOSSIERS.put('__vectorized_slugs', JSON.stringify(indexedSlugs));
      }
      await env.DOSSIERS.put(`${slug}:vectorized_at`, new Date().toISOString());

      return jsonResponse({
        ok: true,
        slug,
        chunksIndexed: upsertVectors.length
      });
    }

    // ── /api/index DELETE — remove a slug's vectors ───────────────
    if (url.pathname === '/api/index' && request.method === 'DELETE') {
      if (!env.VECTORIZE) {
        return jsonResponse({ error: 'VECTORIZE binding not configured' }, 500);
      }
      const slug = url.searchParams.get('slug');
      if (!slug) return jsonResponse({ error: 'slug required' }, 400);

      // List and delete all vectors for this slug
      // Vectorize doesn't support delete-by-metadata, so we track IDs in KV
      const idsRaw = await env.DOSSIERS.get(`${slug}:vector_ids`);
      if (idsRaw) {
        const ids = JSON.parse(idsRaw);
        await env.VECTORIZE.deleteByIds(ids);
        await env.DOSSIERS.delete(`${slug}:vector_ids`);
      }
      await env.DOSSIERS.delete(`${slug}:vectorized_at`);

      return jsonResponse({ ok: true, slug });
    }

    // ── /api/dossier — KV-backed dossier read/write ───────────────
    if (url.pathname === '/api/dossier') {
      // Defensive check: KV binding might not exist if Cloudflare wasn't configured yet
      if (!env.DOSSIERS) {
        return jsonResponse({ error: 'KV namespace DOSSIERS not bound' }, 500);
      }

      // GET ?slug=nour-el-nil → returns { slug, dossier, exists }
      if (request.method === 'GET') {
        const slug = url.searchParams.get('slug');
        if (!slug) return jsonResponse({ error: 'slug parameter required' }, 400);
        const dossier = await env.DOSSIERS.get(slug);
        return jsonResponse({
          slug: slug,
          dossier: dossier || null,
          exists: dossier !== null
        });
      }

      // POST { slug, dossier } → saves and returns { ok, slug }
      if (request.method === 'POST') {
        try {
          const data = await request.json();
          if (!data.slug || typeof data.slug !== 'string') {
            return jsonResponse({ error: 'slug required' }, 400);
          }
          if (typeof data.dossier !== 'string') {
            return jsonResponse({ error: 'dossier must be a string' }, 400);
          }
          await env.DOSSIERS.put(data.slug, data.dossier);
          return jsonResponse({ ok: true, slug: data.slug, length: data.dossier.length });
        } catch (err) {
          return jsonResponse({ error: 'invalid JSON: ' + err.message }, 400);
        }
      }

      return new Response('Method not allowed', { status: 405 });
    }

    // ── /api/itinerary — KV-backed itinerary read/write ──────────
    // Itineraries are stored as JSON objects under the key {slug}:itinerary
    // Shape: { duration: string, headline: string, days: [{ label, title, desc }] }
    if (url.pathname === '/api/itinerary') {
      if (!env.DOSSIERS) {
        return jsonResponse({ error: 'KV namespace DOSSIERS not bound' }, 500);
      }

      // GET ?slug=nour-el-nil → returns { slug, itinerary, exists }
      if (request.method === 'GET') {
        const slug = url.searchParams.get('slug');
        if (!slug) return jsonResponse({ error: 'slug parameter required' }, 400);
        const raw = await env.DOSSIERS.get(slug + ':itinerary');
        let itinerary = null;
        if (raw) {
          try { itinerary = JSON.parse(raw); } catch (e) { itinerary = null; }
        }
        return jsonResponse({
          slug: slug,
          itinerary: itinerary,
          exists: itinerary !== null
        });
      }

      // POST { slug, itinerary } → saves and returns { ok, slug, length }
      if (request.method === 'POST') {
        try {
          const data = await request.json();
          if (!data.slug || typeof data.slug !== 'string') {
            return jsonResponse({ error: 'slug required' }, 400);
          }
          if (!data.itinerary || typeof data.itinerary !== 'object') {
            return jsonResponse({ error: 'itinerary object required' }, 400);
          }
          const serialized = JSON.stringify(data.itinerary);
          await env.DOSSIERS.put(data.slug + ':itinerary', serialized);
          return jsonResponse({
            ok: true,
            slug: data.slug,
            length: serialized.length,
            days: (data.itinerary.days || []).length
          });
        } catch (err) {
          return jsonResponse({ error: 'invalid JSON: ' + err.message }, 400);
        }
      }

      return new Response('Method not allowed', { status: 405 });
    }

    // ── /api/source — URL fetch + HTML strip + KV cache ──────────
    if (url.pathname === '/api/source') {
      if (!env.DOSSIERS) {
        return jsonResponse({ error: 'KV namespace DOSSIERS not bound' }, 500);
      }

      // GET ?slug=... → returns all cached sources for the slug as an array
      if (request.method === 'GET') {
        const slug = url.searchParams.get('slug');
        if (!slug) return jsonResponse({ error: 'slug parameter required' }, 400);
        // Sources are stored as keys like "{slug}:source:{n}"
        // KV doesn't have great list-by-prefix semantics for this scale, so we
        // just check slots 1 through 10 in parallel
        const slots = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const sources = await Promise.all(slots.map(async (n) => {
          const key = slug + ':source:' + n;
          const raw = await env.DOSSIERS.get(key);
          if (!raw) return null;
          try {
            const parsed = JSON.parse(raw);
            return { slot: n, ...parsed };
          } catch (e) {
            return null;
          }
        }));
        return jsonResponse({
          slug: slug,
          sources: sources.filter(s => s !== null)
        });
      }

      // POST { slug, slot, url, label, manualContent? } → fetches URL, strips HTML, caches
      // If manualContent is present, skip fetching and store the pasted content directly.
      if (request.method === 'POST') {
        let data;
        try {
          data = await request.json();
        } catch (err) {
          return jsonResponse({ error: 'invalid JSON: ' + err.message }, 400);
        }
        if (!data.slug || !data.slot) {
          return jsonResponse({ error: 'slug and slot required' }, 400);
        }

        // ── Manual paste path: bypass network fetch entirely ──
        if (data.manualContent && typeof data.manualContent === 'string') {
          let text = data.manualContent.trim();
          const MAX_LEN = 50000;
          let truncated = false;
          if (text.length > MAX_LEN) {
            text = text.substring(0, MAX_LEN) + '\n\n[... content truncated to 50KB ...]';
            truncated = true;
          }
          const cacheEntry = {
            url: data.url || 'manual-paste',
            label: data.label || 'Manual paste',
            content: text,
            fetchedAt: new Date().toISOString(),
            length: text.length,
            truncated: truncated,
            manual: true
          };
          await env.DOSSIERS.put(data.slug + ':source:' + data.slot, JSON.stringify(cacheEntry));
          return jsonResponse({
            ok: true,
            slug: data.slug,
            slot: data.slot,
            length: text.length,
            truncated: truncated,
            manual: true,
            fetchedAt: cacheEntry.fetchedAt
          });
        }

        if (!data.url) {
          return jsonResponse({ error: 'url required (or manualContent)' }, 400);
        }

        // Fetch the URL with a reasonable timeout and a friendly user agent
        let html, fetchStatus;
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15000);
          const sourceResponse = await fetch(data.url, {
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; TheBearingBot/1.0; +https://thebearing.io)',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9'
            },
            redirect: 'follow',
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          fetchStatus = sourceResponse.status;
          if (!sourceResponse.ok) {
            return jsonResponse({
              error: 'Failed to fetch URL',
              status: sourceResponse.status,
              statusText: sourceResponse.statusText,
              hint: sourceResponse.status === 403 || sourceResponse.status === 401
                ? 'Site appears to block bots. Use the "paste content directly" fallback.'
                : sourceResponse.status === 404
                ? 'URL not found. Check the link.'
                : 'Site returned an error. You may need to paste content manually.'
            }, 502);
          }
          const contentType = sourceResponse.headers.get('content-type') || '';
          if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml')) {
            return jsonResponse({
              error: 'URL did not return HTML or text',
              contentType: contentType,
              hint: 'Only text/HTML pages can be cached. PDFs, images, and other formats are not supported yet.'
            }, 415);
          }
          html = await sourceResponse.text();
        } catch (err) {
          if (err.name === 'AbortError') {
            return jsonResponse({ error: 'Fetch timed out after 15 seconds', hint: 'Site is slow or unreachable.' }, 504);
          }
          return jsonResponse({ error: 'Network error: ' + err.message, hint: 'Try the manual paste fallback.' }, 502);
        }

        // Strip HTML to plain text. Remove scripts, styles, comments, then tags.
        let text = html;
        text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
        text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
        text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ');
        text = text.replace(/<!--[\s\S]*?-->/g, ' ');
        text = text.replace(/<\/(p|div|h[1-6]|li|br|tr|article|section)>/gi, '\n');
        text = text.replace(/<br\s*\/?>/gi, '\n');
        text = text.replace(/<[^>]+>/g, ' ');
        // Decode common HTML entities
        text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&hellip;/g, '...').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'").replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"');
        // Collapse whitespace
        text = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
        // Cap at 50KB to keep KV writes sane and context costs reasonable
        const MAX_LEN = 50000;
        let truncated = false;
        if (text.length > MAX_LEN) {
          text = text.substring(0, MAX_LEN) + '\n\n[... content truncated to 50KB ...]';
          truncated = true;
        }

        const cacheEntry = {
          url: data.url,
          label: data.label || '',
          content: text,
          fetchedAt: new Date().toISOString(),
          length: text.length,
          truncated: truncated
        };
        const key = data.slug + ':source:' + data.slot;
        await env.DOSSIERS.put(key, JSON.stringify(cacheEntry));
        return jsonResponse({
          ok: true,
          slug: data.slug,
          slot: data.slot,
          url: data.url,
          length: text.length,
          truncated: truncated,
          fetchedAt: cacheEntry.fetchedAt
        });
      }

      // DELETE ?slug=...&slot=... → removes a cached source
      if (request.method === 'DELETE') {
        const slug = url.searchParams.get('slug');
        const slot = url.searchParams.get('slot');
        if (!slug || !slot) return jsonResponse({ error: 'slug and slot required' }, 400);
        await env.DOSSIERS.delete(slug + ':source:' + slot);
        return jsonResponse({ ok: true, slug: slug, slot: slot });
      }

      return new Response('Method not allowed', { status: 405 });
    }

    // ── /api/property — full property data save/load/delete/list ──
    // Keys: {slug}:property  (JSON string)
    // List index key: __property_index (JSON array of slugs)
    if (url.pathname === '/api/property') {
      if (!env.DOSSIERS) {
        return jsonResponse({ error: 'KV namespace DOSSIERS not bound' }, 500);
      }

      // GET ?slug=... → returns { slug, data, exists }
      // GET (no slug)  → returns { slugs: [...] }
      if (request.method === 'GET') {
        const slug = url.searchParams.get('slug');
        if (!slug) {
          // Return index — defensively filter out reserved/internal slugs that
          // shouldn't be there but historically slipped in (e.g. __index_cruises
          // got POSTed as a property slug in early versions of the reorder UI).
          const rawIndex = await env.DOSSIERS.get('__property_index');
          let slugs = rawIndex ? JSON.parse(rawIndex) : [];
          slugs = slugs.filter(function(s) {
            return typeof s === 'string' && s.length > 0 && !s.startsWith('__');
          });
          return jsonResponse({ slugs });
        }
        const raw = await env.DOSSIERS.get(slug + ':property');
        let data = null;
        if (raw) {
          try { data = JSON.parse(raw); } catch (e) { data = null; }
        }
        // On-read backfill of schema fields added in later builds. Idempotent —
        // records that already have the fields are untouched. Pattern can be
        // reused for any future schema addition: check, fill default, return.
        // Note: we do NOT write the backfilled values back to KV here on read,
        // for two reasons: (1) GET handlers shouldn't have write side effects,
        // (2) the values will be persisted on the next legitimate POST anyway.
        // The cost is microseconds per read.
        if (data && typeof data === 'object') {
          // v72x: commission_pct (percent TheBearing collects as deposit).
          // null means "not yet set" — admin UI flags this as required before
          // the property can take real bookings. A non-null value must be
          // a number in [1, 25].
          if (typeof data.commission_pct !== 'number') {
            data.commission_pct = null;
          }
          // v72x: booking_type. Only "enquiry" is valid in v1. Reserved
          // values: "instant" (PMS-integrated, future), "package" (future).
          if (!data.booking_type) {
            data.booking_type = 'enquiry';
          }
        }
        return jsonResponse({ slug, data, exists: data !== null });
      }

      // POST { slug, property } → saves full property JSON, updates index
      if (request.method === 'POST') {
        if (!(await isAdmin())) return adminDenied();
        let body;
        try { body = await request.json(); }
        catch (err) { return jsonResponse({ error: 'invalid JSON: ' + err.message }, 400); }
        if (!body.slug || typeof body.slug !== 'string') {
          return jsonResponse({ error: 'slug required (string)' }, 400);
        }
        // Special case: the three curated listing-order keys (`__index_hotels`,
        // `__index_cruises`, `__index_villas`) are legitimate writes via this
        // endpoint — they store `{slugs:[...]}` arrays controlling the order
        // properties appear on public listing pages. The admin "Save order"
        // button posts to them. Validate the payload shape, write, and return
        // — don't add to __property_index, don't apply the regular slug rules.
        const slugLower = body.slug.trim().toLowerCase();
        const ALLOWED_INDEX_SLUGS = ['__index_hotels', '__index_cruises', '__index_villas'];
        if (ALLOWED_INDEX_SLUGS.indexOf(slugLower) !== -1) {
          if (!body.property || typeof body.property !== 'object' || !Array.isArray(body.property.slugs)) {
            return jsonResponse({ error: 'curated-index payload must be { slugs: [...] }' }, 400);
          }
          // Filter the slugs array itself — never let real `__*` junk into the curated lists
          const cleanSlugs = body.property.slugs.filter(function(s) {
            return typeof s === 'string' && s.length > 0 && !s.startsWith('__');
          });
          const indexPayload = JSON.stringify({
            slugs: cleanSlugs,
            updatedAt: new Date().toISOString()
          });
          // Store under TWO keys for compatibility:
          //   `{slug}:property` — what /api/property?slug=__index_X reads (legacy path)
          //   `{slug}`          — direct key (preferred going forward)
          await env.DOSSIERS.put(slugLower + ':property', indexPayload);
          await env.DOSSIERS.put(slugLower, indexPayload);
          return jsonResponse({ ok: true, slug: slugLower, slugs: cleanSlugs });
        }
        // Reject reserved/internal slugs and any slug that would collide with KV
        // key conventions (`__settings:*`, `__cron:*`, `__index_*`, `__property_index`,
        // `member:*`, `booking:*`, `conversation:*`, etc.). Slug must be url-safe and
        // not start with `__`, not contain `:`, and not be one of a few reserved words.
        const slugVal = slugLower;
        const reserved = ['property', 'properties', 'admin', 'api', 'settings', 'health', 'cron'];
        if (slugVal.length < 2 || slugVal.length > 80) {
          return jsonResponse({ error: 'slug must be 2-80 characters' }, 400);
        }
        if (slugVal.startsWith('__') || slugVal.indexOf(':') !== -1) {
          return jsonResponse({ error: 'slug cannot start with __ or contain :' }, 400);
        }
        if (!/^[a-z0-9-]+$/.test(slugVal)) {
          return jsonResponse({ error: 'slug must be lowercase letters, numbers, hyphens only' }, 400);
        }
        if (reserved.indexOf(slugVal) !== -1) {
          return jsonResponse({ error: 'slug is reserved: ' + slugVal }, 400);
        }
        if (!body.property || typeof body.property !== 'object') {
          return jsonResponse({ error: 'property object required' }, 400);
        }

        // v72x: validate new commercial-terms fields.
        // commission_pct: optional (allows in-progress edits before commission is
        // negotiated), but when present must be a number 1-25. v72v locked the
        // 25% cap as our max negotiated rate. v72z will additionally refuse to
        // create a Stripe checkout for a property whose commission_pct is null —
        // that's where the field becomes truly required, not at save time.
        if (body.property.commission_pct !== undefined && body.property.commission_pct !== null) {
          const c = body.property.commission_pct;
          if (typeof c !== 'number' || !isFinite(c) || c < 1 || c > 25) {
            return jsonResponse({ error: 'commission_pct must be a number between 1 and 25, or null' }, 400);
          }
        }
        // booking_type: optional in payload (will default to "enquiry" on read).
        // If supplied, must match one of the allowed values. "instant" is reserved
        // for a future PMS-integrated build and is intentionally not yet allowed —
        // saving with "instant" would be misleading since no instant-book flow
        // exists. We'll widen this list when v73-something ships that integration.
        if (body.property.booking_type !== undefined && body.property.booking_type !== null) {
          const ALLOWED_BOOKING_TYPES = ['enquiry'];
          if (ALLOWED_BOOKING_TYPES.indexOf(body.property.booking_type) === -1) {
            return jsonResponse({
              error: 'booking_type must be one of: ' + ALLOWED_BOOKING_TYPES.join(', ')
            }, 400);
          }
        }

        const serialized = JSON.stringify(body.property);
        await env.DOSSIERS.put(slugVal + ':property', serialized);

        // Update index — also defensively filter junk while we're rewriting it
        const rawIndex = await env.DOSSIERS.get('__property_index');
        let slugs = rawIndex ? JSON.parse(rawIndex) : [];
        slugs = slugs.filter(function(s) {
          return typeof s === 'string' && s.length > 0 && !s.startsWith('__');
        });
        if (!slugs.includes(slugVal)) {
          slugs.push(slugVal);
          await env.DOSSIERS.put('__property_index', JSON.stringify(slugs));
        } else if (rawIndex && JSON.parse(rawIndex).length !== slugs.length) {
          // We just dropped some junk — persist the cleanup
          await env.DOSSIERS.put('__property_index', JSON.stringify(slugs));
        }
        return jsonResponse({ ok: true, slug: slugVal, length: serialized.length });
      }

      // DELETE ?slug=... → removes property and updates index
      if (request.method === 'DELETE') {
        if (!(await isAdmin())) return adminDenied();
        const slug = url.searchParams.get('slug');
        if (!slug) return jsonResponse({ error: 'slug required' }, 400);
        await env.DOSSIERS.delete(slug + ':property');
        const rawIndex = await env.DOSSIERS.get('__property_index');
        let slugs = rawIndex ? JSON.parse(rawIndex) : [];
        slugs = slugs.filter(s => s !== slug);
        await env.DOSSIERS.put('__property_index', JSON.stringify(slugs));
        return jsonResponse({ ok: true, slug, deleted: true });
      }

      return new Response('Method not allowed', { status: 405 });
    }

    // ── /api/property/offer-defaults ───────────────────────────────
    // v73j: lightweight admin-gated endpoint to patch ONLY the
    // partner-saved offer defaults on a property record, without
    // round-tripping the full property JSON through the admin editor.
    // Used by the "Save as default" buttons on the pp-bookings offer
    // modal so partners can preserve their inclusions / cancellation /
    // notes between offers.
    //
    // POST body: { slug, field, value }
    //   field: 'default_inclusions' | 'default_cancellation_terms' | 'default_partner_notes' | 'default_pricing_mode'
    //   value: array for inclusions, string for others
    if (url.pathname === '/api/property/offer-defaults') {
      if (!(await isAdmin())) return adminDenied();
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      let body;
      try { body = await request.json(); }
      catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
      if (!body.slug) return jsonResponse({ error: 'slug required' }, 400);
      const ALLOWED_FIELDS = ['default_inclusions', 'default_cancellation_terms', 'default_partner_notes', 'default_pricing_mode'];
      if (ALLOWED_FIELDS.indexOf(body.field) === -1) {
        return jsonResponse({ error: 'field must be one of: ' + ALLOWED_FIELDS.join(', ') }, 400);
      }
      // Type-check value
      if (body.field === 'default_inclusions') {
        if (!Array.isArray(body.value)) return jsonResponse({ error: 'inclusions must be an array' }, 400);
      } else if (body.field === 'default_pricing_mode') {
        if (body.value !== 'per_night' && body.value !== 'package') {
          return jsonResponse({ error: 'pricing_mode must be per_night or package' }, 400);
        }
      } else {
        if (typeof body.value !== 'string') return jsonResponse({ error: 'value must be a string' }, 400);
      }

      const raw = await env.DOSSIERS.get(body.slug + ':property');
      if (!raw) return jsonResponse({ error: 'property not found: ' + body.slug }, 404);
      let prop;
      try { prop = JSON.parse(raw); } catch (e) { return jsonResponse({ error: 'corrupt property JSON' }, 500); }

      prop[body.field] = body.value;
      prop.updatedAt = new Date().toISOString();
      await env.DOSSIERS.put(body.slug + ':property', JSON.stringify(prop));

      return jsonResponse({ ok: true, slug: body.slug, field: body.field, value: body.value });
    }

    // ── /api/conversation/backfill-bookings ────────────────────────
    // v73i: admin-gated one-shot. Walks every conversation in
    // __conversations_index; for each one that doesn't have a linked
    // booking (conv.bookingRef missing), creates a stub `booking:{ref}`
    // record with status:'enquiry' so it appears in pp-bookings.
    // Needed because v73g added stub-on-create but didn't backfill old
    // enquiries. Idempotent — safe to run multiple times.
    if (url.pathname === '/api/conversation/backfill-bookings') {
      if (!(await isAdmin())) return adminDenied();
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      const idxRaw = await env.DOSSIERS.get('__conversations_index');
      const convIds = idxRaw ? JSON.parse(idxRaw) : [];
      const created = [];
      const skipped = [];
      const errors = [];

      // Load current booking index once so we can append
      const bIdxRaw = await env.DOSSIERS.get('__bookings_index');
      const bRefs = bIdxRaw ? JSON.parse(bIdxRaw) : [];

      for (const cid of convIds) {
        try {
          const raw = await env.DOSSIERS.get('conversation:' + cid);
          if (!raw) { skipped.push({ id: cid, reason: 'no-record' }); continue; }
          const conv = JSON.parse(raw);
          if (conv.bookingRef) { skipped.push({ id: cid, reason: 'already-linked', ref: conv.bookingRef }); continue; }
          if (conv.status === 'archived') { skipped.push({ id: cid, reason: 'archived' }); continue; }
          if (!conv.propertySlug) { skipped.push({ id: cid, reason: 'no-slug' }); continue; }

          const year = new Date(conv.createdAt || Date.now()).getFullYear();
          const rand = Math.floor(1000 + Math.random() * 9000);
          const ref = 'TB-' + year + '-' + rand;
          const enq = conv.enquiry || {};
          const nameStr = (conv.guestName || conv.guestEmail || '').trim();
          const nameParts = nameStr.split(/\s+/);
          const firstname = nameParts[0] || 'Guest';
          const lastname  = nameParts.slice(1).join(' ') || '';

          const booking = {
            ref,
            property: conv.propertyName || conv.propertySlug,
            slug: conv.propertySlug,
            conversationId: cid,
            arrival:   enq.arrival   || '',
            departure: enq.departure || '',
            nights: '',
            guests: enq.guests || '',
            room: enq.cabin || '',
            roomPrice: 0,
            totalAmount: 0,
            depositAmount: 0,
            firstname, lastname,
            email: conv.guestEmail || '',
            phone: '',
            notes: enq.notes || '',
            status: 'enquiry',
            paymentStatus: 'none',
            createdAt: conv.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          await env.DOSSIERS.put('booking:' + ref, JSON.stringify(booking));
          bRefs.push(ref);

          conv.bookingRef = ref;
          await env.DOSSIERS.put('conversation:' + cid, JSON.stringify(conv));
          created.push({ id: cid, ref, slug: conv.propertySlug });
        } catch (e) {
          errors.push({ id: cid, error: String(e && e.message || e) });
        }
      }

      // Persist updated bookings index once at end
      await env.DOSSIERS.put('__bookings_index', JSON.stringify(bRefs));

      return jsonResponse({
        ok: true,
        scanned: convIds.length,
        created: created.length,
        skipped: skipped.length,
        errors: errors.length,
        details: { created, skipped: skipped.slice(0, 20), errors }
      });
    }

    // ── /api/booking/cancel-stale-enquiries ────────────────────────
    // v73m: admin-gated. Cancels every booking with status='enquiry' or
    // 'pending' that pre-dates a cutoff date (default: 2026-05-12, the
    // day before v73j shipped). These are stub bookings created by v73g/i
    // before the offer flow existed — they have no path forward because
    // their linked conversations were never set up to receive an offer
    // card. Cleanest UX is to mark them cancelled so they drop off the
    // customer's bookings view.
    // Body: { cutoff?: 'YYYY-MM-DD' } — optional override of cutoff
    if (url.pathname === '/api/booking/cancel-stale-enquiries') {
      if (!(await isAdmin())) return adminDenied();
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      let body = {};
      try { body = await request.json(); } catch (e) {}
      const cutoffStr = body.cutoff || '2026-05-12';
      const cutoff = new Date(cutoffStr + 'T23:59:59Z').getTime();
      if (isNaN(cutoff)) return jsonResponse({ error: 'invalid cutoff date' }, 400);

      const idxRaw = await env.DOSSIERS.get('__bookings_index');
      const refs = idxRaw ? JSON.parse(idxRaw) : [];
      const cancelled = [];
      const skipped = [];
      const errors = [];

      for (const ref of refs) {
        try {
          const raw = await env.DOSSIERS.get('booking:' + ref);
          if (!raw) { skipped.push({ ref, reason: 'no-record' }); continue; }
          const booking = JSON.parse(raw);
          const status = (booking.status || '').toLowerCase();
          if (status !== 'enquiry' && status !== 'pending') {
            skipped.push({ ref, reason: 'status-not-enquiry', status });
            continue;
          }
          const created = new Date(booking.createdAt || 0).getTime();
          if (!created || created > cutoff) {
            skipped.push({ ref, reason: 'after-cutoff', createdAt: booking.createdAt });
            continue;
          }
          const now = new Date().toISOString();
          booking.status = 'cancelled';
          booking.cancelledAt = now;
          booking.cancelledBy = 'admin-batch-stale';
          booking.updatedAt = now;
          await env.DOSSIERS.put('booking:' + ref, JSON.stringify(booking));

          // Archive linked conversation
          if (booking.conversationId) {
            try {
              const convRaw = await env.DOSSIERS.get('conversation:' + booking.conversationId);
              if (convRaw) {
                const conv = JSON.parse(convRaw);
                conv.status = 'archived';
                conv.archivedAt = now;
                conv.archivedReason = 'enquiry_cancelled_admin_batch';
                await env.DOSSIERS.put('conversation:' + booking.conversationId, JSON.stringify(conv));
              }
            } catch (e) {
              console.error('[cancel-stale] conv archive failed for ' + ref + ':', e);
            }
          }
          cancelled.push({ ref, slug: booking.slug, createdAt: booking.createdAt });
        } catch (e) {
          errors.push({ ref, error: String(e && e.message || e) });
        }
      }

      return jsonResponse({
        ok: true,
        cutoff: cutoffStr,
        scanned: refs.length,
        cancelled: cancelled.length,
        skipped: skipped.length,
        errors: errors.length,
        details: { cancelled, skipped: skipped.slice(0, 20), errors }
      });
    }

    // ── /api/booking/restore-from-offer ────────────────────────────
    // v73r: admin-gated. For every booking with active_offer_id set, copy
    // arrival/departure/guests/room from the offer back to the booking.
    // Repairs the data corruption introduced when a guest re-enquired on
    // a property with an open offer — pre-v73r the worker silently rewrote
    // booking dates while the offer kept its original dates, leaving the
    // two records disagreeing. Also clears any stale pendingChangeRequest.
    // Idempotent.
    if (url.pathname === '/api/booking/restore-from-offer') {
      if (!(await isAdmin())) return adminDenied();
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      const bIdxRaw = await env.DOSSIERS.get('__bookings_index');
      const bRefs = bIdxRaw ? JSON.parse(bIdxRaw) : [];
      let scanned = 0, restored = 0, skipped = 0, errors = 0;
      const details = { restored: [], skipped: [], errors: [] };
      const now = new Date().toISOString();
      const fmt = function(s){ try { return new Date(s.length===10?s+'T00:00':s).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); } catch(_){ return s; } };

      for (const ref of bRefs) {
        try {
          const bRaw = await env.DOSSIERS.get('booking:' + ref);
          if (!bRaw) continue;
          const booking = JSON.parse(bRaw);
          if (!booking.active_offer_id) continue;
          scanned++;
          const offerRaw = await env.DOSSIERS.get('offer:' + booking.active_offer_id);
          if (!offerRaw) {
            skipped++;
            if (details.skipped.length < 30) details.skipped.push({ ref: ref, reason: 'offer not found: ' + booking.active_offer_id });
            continue;
          }
          const offer = JSON.parse(offerRaw);
          const beforeArr = booking.arrival, beforeDep = booking.departure;
          const matchesAlready = (booking.arrival === offer.arrival) && (booking.departure === offer.departure) && (!booking.pendingChangeRequest);
          if (matchesAlready) {
            skipped++;
            if (details.skipped.length < 30) details.skipped.push({ ref: ref, reason: 'already matches offer' });
            continue;
          }
          if (offer.arrival)   booking.arrival   = offer.arrival;
          if (offer.departure) booking.departure = offer.departure;
          if (offer.nights)    booking.nights    = offer.nights;
          if (offer.guests)    booking.guests    = offer.guests;
          if (offer.room)      booking.room      = offer.room;
          delete booking.pendingChangeRequest;
          booking.updatedAt = now;
          await env.DOSSIERS.put('booking:' + ref, JSON.stringify(booking));
          restored++;
          if (details.restored.length < 100) {
            details.restored.push({
              ref: ref,
              was: (beforeArr && beforeDep) ? (fmt(beforeArr) + ' \u2192 ' + fmt(beforeDep)) : '(unset)',
              now: (offer.arrival && offer.departure) ? (fmt(offer.arrival) + ' \u2192 ' + fmt(offer.departure)) : '(unset)',
            });
          }
        } catch (e) {
          errors++;
          if (details.errors.length < 30) details.errors.push({ ref: ref, error: e.message });
        }
      }
      return jsonResponse({ ok: true, scanned: scanned, restored: restored, skipped: skipped, errors: errors, details: details });
    }

    // ── /api/offer/backfill-cards ──────────────────────────────────
    // v73m: admin-gated. For every offer with status='sent', check if its
    // linked conversation already has an offer_card message. If not, post
    // one. Idempotent — safe to run repeatedly. Used once to backfill
    // offers sent before v73j (which added auto-card-posting on send).
    if (url.pathname === '/api/offer/backfill-cards') {
      if (!(await isAdmin())) return adminDenied();
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      // Walk bookings to find all offers (no global offer index exists)
      const bIdxRaw = await env.DOSSIERS.get('__bookings_index');
      const bRefs = bIdxRaw ? JSON.parse(bIdxRaw) : [];
      const allOfferIds = new Set();
      for (const ref of bRefs) {
        try {
          const offerIdxRaw = await env.DOSSIERS.get('__offers_by_booking:' + ref);
          if (!offerIdxRaw) continue;
          const offerIds = JSON.parse(offerIdxRaw);
          if (Array.isArray(offerIds)) offerIds.forEach(function(id) { allOfferIds.add(id); });
        } catch (e) {}
      }

      const posted = [];
      const skipped = [];
      const errors = [];

      for (const offerId of allOfferIds) {
        try {
          const raw = await env.DOSSIERS.get('offer:' + offerId);
          if (!raw) { skipped.push({ offerId, reason: 'no-record' }); continue; }
          const offer = JSON.parse(raw);
          if (offer.status !== 'sent') {
            skipped.push({ offerId, reason: 'not-sent-status', status: offer.status });
            continue;
          }
          // Find conversation via booking
          const brRaw = await env.DOSSIERS.get('booking:' + offer.bookingId);
          if (!brRaw) { skipped.push({ offerId, reason: 'no-booking' }); continue; }
          const bk = JSON.parse(brRaw);
          const convId = bk.conversationId;
          if (!convId) { skipped.push({ offerId, reason: 'no-conversation' }); continue; }
          const msgsRaw = await env.DOSSIERS.get('conversation:' + convId + ':messages');
          const messages = msgsRaw ? JSON.parse(msgsRaw) : [];
          const alreadyPosted = messages.some(function(m) {
            return m.type === 'offer_card' && m.offerId === offerId;
          });
          if (alreadyPosted) {
            skipped.push({ offerId, reason: 'card-already-present' });
            continue;
          }
          const convRaw = await env.DOSSIERS.get('conversation:' + convId);
          if (!convRaw) { skipped.push({ offerId, reason: 'conv-record-missing' }); continue; }
          const conv = JSON.parse(convRaw);
          // Skip archived/cancelled conversations
          if (conv.status === 'archived') {
            skipped.push({ offerId, reason: 'conv-archived' });
            continue;
          }

          const cardTs = offer.sent_at || new Date().toISOString();
          messages.push({
            id: 'msg_' + Date.now() + '_card_bf',
            role: 'partner',
            type: 'offer_card',
            offerId: offer.id,
            offerSummary: {
              propertyName: offer.propertyName || '',
              arrival: offer.arrival || '',
              departure: offer.departure || '',
              nights: offer.nights || 0,
              guests: offer.guests || 0,
              room: offer.room || '',
              total_amount: offer.total_amount || 0,
              deposit_amount: offer.deposit_amount || 0,
              currency: offer.currency || 'USD',
              valid_until: offer.valid_until || null
            },
            text: 'Your offer is ready \u2014 ' + (offer.propertyName || 'the property') + ' has prepared a personalised quote. Open your conversation to view it.',
            senderName: offer.propertyName || 'Property',
            sentAt: cardTs,
            readAt: null
          });
          await env.DOSSIERS.put('conversation:' + convId + ':messages', JSON.stringify(messages));
          // Don't bump unreadGuest — this is a historical backfill, not a fresh notification
          posted.push({ offerId, convId, sentAt: cardTs });
        } catch (e) {
          errors.push({ offerId, error: String(e && e.message || e) });
        }
      }

      return jsonResponse({
        ok: true,
        scanned: allOfferIds.size,
        posted: posted.length,
        skipped: skipped.length,
        errors: errors.length,
        details: { posted, skipped: skipped.slice(0, 30), errors }
      });
    }

    // ── /api/property/cleanup ─────────────────────────────────────
    // Admin-gated. One-shot janitor: scrubs `__property_index` of (a) reserved
    // slugs starting with `__`, (b) slugs whose `{slug}:property` KV record is
    // missing/empty/invalid JSON, (c) duplicates. Also deletes the offending
    // `{slug}:property` records for known-bad slugs (e.g. `__index_cruises:property`)
    // so they stop polluting future scans. Idempotent — safe to run repeatedly.
    if (url.pathname === '/api/property/cleanup') {
      if (!(await isAdmin())) return adminDenied();
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      const rawIndex = await env.DOSSIERS.get('__property_index');
      const original = rawIndex ? JSON.parse(rawIndex) : [];
      const seen = {};
      const kept = [];
      const dropped = [];

      for (const slug of original) {
        if (typeof slug !== 'string' || !slug.length) {
          dropped.push({ slug: String(slug), reason: 'not-a-string' });
          continue;
        }
        if (slug.startsWith('__')) {
          dropped.push({ slug, reason: 'reserved-prefix' });
          // Best-effort delete the rogue `{slug}:property` record too
          try { await env.DOSSIERS.delete(slug + ':property'); } catch(_) {}
          continue;
        }
        if (seen[slug]) {
          dropped.push({ slug, reason: 'duplicate' });
          continue;
        }
        // Verify the property record actually exists and parses
        const raw = await env.DOSSIERS.get(slug + ':property');
        if (!raw) {
          dropped.push({ slug, reason: 'no-record' });
          continue;
        }
        try {
          const parsed = JSON.parse(raw);
          // Must at minimum have a name; otherwise it's an empty stub
          if (!parsed || typeof parsed !== 'object' || !parsed.name) {
            dropped.push({ slug, reason: 'empty-record' });
            // Don't auto-delete the record — the admin may want to inspect it.
            // Just remove from the index.
            continue;
          }
        } catch(e) {
          dropped.push({ slug, reason: 'invalid-json: ' + e.message });
          continue;
        }
        seen[slug] = true;
        kept.push(slug);
      }

      await env.DOSSIERS.put('__property_index', JSON.stringify(kept));

      return jsonResponse({
        ok: true,
        before: original.length,
        after: kept.length,
        kept: kept,
        dropped: dropped
      });
    }

    // ── /api/upload — Cloudflare Images direct upload ─────────────
    // POST with multipart/form-data containing a "file" field.
    // Worker fetches a one-time upload URL from CF Images, uploads
    // the file server-side, and returns { ok, url, id }.
    if (url.pathname === '/api/upload') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }

      const token = env.CF_IMAGES_TOKEN;
      if (!token) {
        return jsonResponse({ error: 'CF_IMAGES_TOKEN secret not configured' }, 500);
      }

      let formData;
      try {
        formData = await request.formData();
      } catch (err) {
        return jsonResponse({ error: 'Could not parse form data: ' + err.message }, 400);
      }

      const file = formData.get('file');
      if (!file) {
        return jsonResponse({ error: 'No file field in form data' }, 400);
      }

      // Upload directly to Cloudflare Images using the API
      const uploadForm = new FormData();
      uploadForm.append('file', file);

      const cfRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/images/v1`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`
          },
          body: uploadForm
        }
      );

      const cfData = await cfRes.json();

      if (!cfRes.ok || !cfData.success) {
        const errMsg = cfData.errors && cfData.errors.length
          ? cfData.errors.map(e => e.message).join(', ')
          : 'Cloudflare Images upload failed';
        return jsonResponse({ error: errMsg }, 502);
      }

      const imageId = cfData.result.id;
      // Store both the base URL and image ID so templates can request appropriate sizes
      // /public serves the default variant — configure it in CF Images dashboard to be full res
      const deliveryUrl = `https://imagedelivery.net/${CF_ACCOUNT_HASH}/${imageId}/public`;

      return jsonResponse({
        ok: true,
        id: imageId,
        url: deliveryUrl
      });
    }

    // ── /api/booking ──────────────────────────────────────────────
    if (url.pathname === '/api/booking') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      // GET — list all bookings or fetch one
      // v72y: backfills `offers` (array) and `active_offer_id` (string|null)
      // on read. Idempotent — records already with these fields are untouched.
      // Adds `?slug=X` filter so partner portal can scope to its property.
      function backfillBookingShape(b) {
        if (!b || typeof b !== 'object') return b;
        if (!Array.isArray(b.offers)) b.offers = [];
        if (typeof b.active_offer_id === 'undefined') b.active_offer_id = null;
        return b;
      }
      if (request.method === 'GET') {
        const ref = url.searchParams.get('ref');
        if (ref) {
          const raw = await env.DOSSIERS.get('booking:' + ref);
          const data = raw ? backfillBookingShape(JSON.parse(raw)) : null;
          return jsonResponse({ ref, data, exists: !!data });
        }
        const slugFilter = url.searchParams.get('slug');
        const emailFilter = url.searchParams.get('email'); // v73k: customer-scoped lookup
        const rawIndex = await env.DOSSIERS.get('__bookings_index');
        const refs = rawIndex ? JSON.parse(rawIndex) : [];
        let bookings = await Promise.all(refs.map(async (r) => {
          const raw = await env.DOSSIERS.get('booking:' + r);
          if (!raw) return null;
          const parsed = backfillBookingShape(JSON.parse(raw));
          return { ref: r, ...parsed };
        }));
        bookings = bookings.filter(Boolean);
        if (slugFilter) {
          // Partner-scoped view: only bookings for this property.
          // Match against the canonical `slug` field. Bookings without a slug
          // are excluded from partner views (they shouldn't exist post-v72y
          // since the booking POST always stores slug now).
          bookings = bookings.filter(function(b) { return b.slug === slugFilter; });
        }
        if (emailFilter) {
          // v73k: customer-scoped view — used by /bookings.html to show
          // a guest their own bookings + enquiries. Case-insensitive match
          // since email comparisons should be.
          const needle = emailFilter.toLowerCase().trim();
          bookings = bookings.filter(function(b) {
            return b.email && b.email.toLowerCase().trim() === needle;
          });
        }
        return jsonResponse({ bookings: bookings.reverse() });
      }

      // POST — create a booking
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); }
        catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }

        const { property, slug, arrival, departure, guests, room, roomPrice,
                totalAmount, depositAmount, firstname, lastname, email, phone,
                notes, nights } = body;

        if (!email || !firstname || !property) {
          return jsonResponse({ error: 'email, firstname and property required' }, 400);
        }

        // Generate booking reference
        const year = new Date().getFullYear();
        const rand = Math.floor(1000 + Math.random() * 9000);
        const ref = 'TB-' + year + '-' + rand;
        const createdAt = new Date().toISOString();

        const booking = {
          ref, property, slug: slug || '',
          arrival, departure, nights: nights || '',
          guests, room, roomPrice: roomPrice || 0,
          totalAmount: totalAmount || 0,
          depositAmount: depositAmount || 0,
          firstname, lastname, email, phone: phone || '',
          notes: notes || '',
          status: 'pending', // pending → confirmed → cancelled
          paymentStatus: 'deposit_due', // deposit_due → deposit_paid → paid → refunded
          createdAt,
          updatedAt: createdAt,
        };

        // Save booking
        await env.DOSSIERS.put('booking:' + ref, JSON.stringify(booking));

        // Update index
        const rawIndex = await env.DOSSIERS.get('__bookings_index');
        const refs = rawIndex ? JSON.parse(rawIndex) : [];
        refs.push(ref);
        await env.DOSSIERS.put('__bookings_index', JSON.stringify(refs));

        // Send email notification via Resend (if key is set)
        if (env.RESEND_API_KEY) {
          try {
            const guestEmailBody = `
Hi ${firstname},

Your booking request has been received. Here are the details:

Reference: ${ref}
Property: ${property}
Dates: ${arrival} → ${departure} (${nights} nights)
Guests: ${guests}
Room: ${room}
Deposit due: $${depositAmount}

The property will contact you at ${email} within 24 hours to confirm your stay.

— The Bearing
https://thebearing.io
            `.trim();

            const adminEmailBody = `
New booking request — ${ref}

Guest: ${firstname} ${lastname}
Email: ${email}
Phone: ${phone || 'not provided'}
Property: ${property}
Dates: ${arrival} → ${departure} (${nights} nights)
Guests: ${guests}
Room: ${room}
Total: $${totalAmount} | Deposit: $${depositAmount}
Notes: ${notes || 'none'}

View in admin: https://thebearing.io/admin-bookings.html
            `.trim();

            const adminRecipients = await loadNotificationRecipients(env);

            await Promise.all([
              fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  from: 'The Bearing <bookings@thebearing.io>',
                  to: [email],
                  subject: `Booking request received — ${ref} · ${property}`,
                  text: guestEmailBody
                })
              }),
              fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  from: 'The Bearing Bookings <bookings@thebearing.io>',
                  to: adminRecipients,
                  subject: `New booking — ${ref} · ${firstname} ${lastname} · ${property}`,
                  text: adminEmailBody
                })
              })
            ]);
          } catch (emailErr) {
            console.error('[Booking] Email error:', emailErr.message);
            // Non-fatal — booking is still saved
          }
        }

        return jsonResponse({ ok: true, ref, booking });
      }

      // PATCH — update booking status
      if (request.method === 'PATCH') {
        let body;
        try { body = await request.json(); }
        catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
        const { ref, status, paymentStatus, notes, action, requesterEmail } = body;
        if (!ref) return jsonResponse({ error: 'ref required' }, 400);
        const raw = await env.DOSSIERS.get('booking:' + ref);
        if (!raw) return jsonResponse({ error: 'booking not found' }, 404);
        const booking = JSON.parse(raw);

        // v73m: customer-driven cancel-enquiry. Only allowed when:
        //  - booking is in enquiry/pending state (can't cancel confirmed bookings here)
        //  - requesterEmail matches booking.email OR caller is admin
        // Effect: booking.status='cancelled', linked conversation archived,
        // booking dropped out of the customer's Enquiries bucket.
        if (action === 'cancel-enquiry') {
          const isAdminCaller = await isAdmin();
          const bookingEmail = (booking.email || '').toLowerCase().trim();
          const reqEmail = (requesterEmail || '').toLowerCase().trim();
          if (!isAdminCaller && (!reqEmail || reqEmail !== bookingEmail)) {
            return jsonResponse({ error: 'not authorised to cancel this booking' }, 403);
          }
          const cancellableStatuses = ['enquiry', 'pending', 'offer_sent'];
          if (cancellableStatuses.indexOf((booking.status || '').toLowerCase()) === -1) {
            return jsonResponse({ error: 'cannot cancel a booking with status: ' + booking.status }, 400);
          }
          booking.status = 'cancelled';
          booking.cancelledAt = new Date().toISOString();
          booking.cancelledBy = isAdminCaller ? 'admin' : 'guest';
          booking.updatedAt = booking.cancelledAt;
          await env.DOSSIERS.put('booking:' + ref, JSON.stringify(booking));

          // Archive the linked conversation so it stops showing as open.
          if (booking.conversationId) {
            try {
              const convRaw = await env.DOSSIERS.get('conversation:' + booking.conversationId);
              if (convRaw) {
                const conv = JSON.parse(convRaw);
                conv.status = 'archived';
                conv.archivedAt = booking.cancelledAt;
                conv.archivedReason = 'enquiry_cancelled_by_' + booking.cancelledBy;
                await env.DOSSIERS.put('conversation:' + booking.conversationId, JSON.stringify(conv));
              }
            } catch (e) {
              console.error('[Cancel enquiry] failed to archive conv:', e);
              // Non-fatal — booking is already cancelled
            }
          }

          // If there's an active offer, withdraw it too so the partner doesn't
          // think the offer is still pending.
          if (booking.active_offer_id) {
            try {
              const offerRaw = await env.DOSSIERS.get('offer:' + booking.active_offer_id);
              if (offerRaw) {
                const offer = JSON.parse(offerRaw);
                if (offer.status === 'sent' || offer.status === 'draft') {
                  offer.status = 'withdrawn';
                  offer.responded_at = booking.cancelledAt;
                  offer.withdrawn_reason = 'enquiry_cancelled';
                  await env.DOSSIERS.put('offer:' + offer.id, JSON.stringify(offer));
                }
              }
            } catch (e) {
              console.error('[Cancel enquiry] failed to withdraw offer:', e);
            }
          }

          return jsonResponse({ ok: true, ref, status: 'cancelled' });
        }

        // Legacy generic PATCH path (admin-driven status changes etc.)
        if (status) booking.status = status;
        if (paymentStatus) booking.paymentStatus = paymentStatus;
        if (notes !== undefined) booking.adminNotes = notes;
        booking.updatedAt = new Date().toISOString();
        await env.DOSSIERS.put('booking:' + ref, JSON.stringify(booking));
        return jsonResponse({ ok: true, ref, booking });
      }

      // DELETE — cancel a booking
      if (request.method === 'DELETE') {
        const ref = url.searchParams.get('ref');
        if (!ref) return jsonResponse({ error: 'ref required' }, 400);
        const raw = await env.DOSSIERS.get('booking:' + ref);
        if (!raw) return jsonResponse({ error: 'booking not found' }, 404);
        const booking = JSON.parse(raw);
        booking.status = 'cancelled';
        booking.updatedAt = new Date().toISOString();
        await env.DOSSIERS.put('booking:' + ref, JSON.stringify(booking));
        return jsonResponse({ ok: true, ref });
      }
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    // ── /api/unread-count ─────────────────────────────────────────
    // Returns lightweight unread counts. Reads a single aggregated KV key
    // instead of scanning every conversation. Designed for fast polling (~2-5s).
    // Query params:
    //   role=admin                          → returns { unread: N } (total open convs with unreadAdmin>0)
    //   role=guest&guestId=xxx              → returns { unread: N } for that guest
    //   role=partner&slug=xxx               → returns { unread: N } for that property
    if (url.pathname === '/api/unread-count') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);
      const role = url.searchParams.get('role') || 'admin';
      const counterRaw = await env.DOSSIERS.get('__unread_counters');
      const counter = counterRaw ? JSON.parse(counterRaw) : { admin: 0, guests: {}, props: {} };

      let unread = 0;
      if (role === 'admin') {
        unread = counter.admin || 0;
      } else if (role === 'guest') {
        const guestId = url.searchParams.get('guestId');
        unread = (guestId && counter.guests && counter.guests[guestId]) || 0;
      } else if (role === 'partner') {
        const slug = url.searchParams.get('slug');
        unread = (slug && counter.props && counter.props[slug]) || 0;
      }
      return jsonResponse({ unread });
    }

    // ── /api/conversation ─────────────────────────────────────────
    // Conversation data model:
    //   conversation:{id}          → { id, propertySlug, propertyName, guestId,
    //                                  guestEmail, guestName, status, createdAt,
    //                                  lastMessageAt, lastMessagePreview,
    //                                  enquiry: { arrival, departure, guests, notes } }
    //   conversation:{id}:messages → [ { id, role, text, senderName, sentAt, readAt } ]
    //   __conversations_index      → [ id, ... ] (all, newest first)
    //   guest:{guestId}:convs      → [ id, ... ] (per-guest)
    //   prop:{slug}:convs          → [ id, ... ] (per-property)

    if (url.pathname === '/api/conversation') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      // GET — fetch one conversation + messages, or list
      if (request.method === 'GET') {
        const id = url.searchParams.get('id');
        const guestId = url.searchParams.get('guestId');
        const slug = url.searchParams.get('slug');

        // Fetch single conversation with messages
        if (id) {
          const raw = await env.DOSSIERS.get('conversation:' + id);
          if (!raw) return jsonResponse({ error: 'not found' }, 404);
          const conv = JSON.parse(raw);
          const msgsRaw = await env.DOSSIERS.get('conversation:' + id + ':messages');
          const messages = msgsRaw ? JSON.parse(msgsRaw) : [];
          return jsonResponse({ conversation: conv, messages });
        }

        // List conversations for a guest
        if (guestId) {
          const rawIds = await env.DOSSIERS.get('guest:' + guestId + ':convs');
          const ids = rawIds ? JSON.parse(rawIds) : [];
          const convs = (await Promise.all(ids.map(async i => {
            const r = await env.DOSSIERS.get('conversation:' + i);
            return r ? JSON.parse(r) : null;
          }))).filter(Boolean).reverse();
          return jsonResponse({ conversations: convs });
        }

        // List conversations for a property
        if (slug) {
          const rawIds = await env.DOSSIERS.get('prop:' + slug + ':convs');
          const ids = rawIds ? JSON.parse(rawIds) : [];
          const convs = (await Promise.all(ids.map(async i => {
            const r = await env.DOSSIERS.get('conversation:' + i);
            return r ? JSON.parse(r) : null;
          }))).filter(Boolean).reverse();
          return jsonResponse({ conversations: convs });
        }

        // List all conversations (admin) — enriched with guest avatars
        const rawIndex = await env.DOSSIERS.get('__conversations_index');
        const ids = rawIndex ? JSON.parse(rawIndex) : [];
        const convs = (await Promise.all(ids.slice(-50).map(async i => {
          const r = await env.DOSSIERS.get('conversation:' + i);
          return r ? JSON.parse(r) : null;
        }))).filter(Boolean).reverse();
        // Enrich each conv with guest avatar (lookup member record)
        await Promise.all(convs.map(async (c) => {
          if (c.guestId && c.guestId.indexOf('user_') === 0 && !c.guestAvatar) {
            try {
              const memberRaw = await env.DOSSIERS.get('member:' + c.guestId);
              if (memberRaw) {
                const member = JSON.parse(memberRaw);
                if (member.avatar) c.guestAvatar = member.avatar;
              }
            } catch(e) {}
          }
        }));
        return jsonResponse({ conversations: convs });
      }

      // POST — create conversation or send message
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); }
        catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }

        // Create new conversation (from enquiry)
        if (body.action === 'create') {
          const { propertySlug, propertyName, guestId, guestEmail, guestName,
                  enquiry, firstMessage } = body;

          if (!propertySlug || !guestEmail) {
            return jsonResponse({ error: 'propertySlug and guestEmail required' }, 400);
          }

          // ── No existing conversation found — create new ──
          const id = 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
          const now = new Date().toISOString();

          const conv = {
            id, propertySlug, propertyName: propertyName || propertySlug,
            guestId: guestId || guestEmail,
            guestEmail, guestName: guestName || guestEmail,
            status: 'open',
            createdAt: now, lastMessageAt: now,
            lastMessagePreview: firstMessage ? firstMessage.substring(0, 100) : '',
            enquiry: enquiry || {},
            unreadAdmin: 1, unreadGuest: 0,
            notifyAdmin: true, notifyPartner: true, notifyGuest: true
          };

          // First message
          const messages = [];
          if (firstMessage) {
            messages.push({
              id: 'msg_' + Date.now(),
              role: 'guest',
              text: firstMessage,
              senderName: guestName || guestEmail,
              sentAt: now,
              readAt: null
            });
          }

          // Save conversation + messages
          await env.DOSSIERS.put('conversation:' + id, JSON.stringify(conv));
          await env.DOSSIERS.put('conversation:' + id + ':messages', JSON.stringify(messages));

          // Update indexes
          const allRaw = await env.DOSSIERS.get('__conversations_index');
          const allIds = allRaw ? JSON.parse(allRaw) : [];
          allIds.push(id);
          await env.DOSSIERS.put('__conversations_index', JSON.stringify(allIds));

          const guestRaw = await env.DOSSIERS.get('guest:' + (guestId||guestEmail) + ':convs');
          const guestIds = guestRaw ? JSON.parse(guestRaw) : [];
          guestIds.push(id);
          await env.DOSSIERS.put('guest:' + (guestId||guestEmail) + ':convs', JSON.stringify(guestIds));

          const propRaw = await env.DOSSIERS.get('prop:' + propertySlug + ':convs');
          const propIds = propRaw ? JSON.parse(propRaw) : [];
          propIds.push(id);
          await env.DOSSIERS.put('prop:' + propertySlug + ':convs', JSON.stringify(propIds));

          // v73g: also create a stub booking with status:'enquiry' so the
          // partner sees the enquiry in pp-bookings with a "Build offer" button.
          // Previously enquiries existed only as conversations, leaving the
          // partner with no surface to start an offer from. Linking
          // conversation ↔ booking via booking.conversationId lets the
          // offer-builder modal in pp-bookings find the right conv.
          // v73i: log every step so we can diagnose if/why pp-bookings shows 0.
          try {
            const year = new Date().getFullYear();
            const rand = Math.floor(1000 + Math.random() * 9000);
            const ref = 'TB-' + year + '-' + rand;
            const enq = enquiry || {};
            console.log('[Conv create] creating stub booking for conv ' + id + ' on slug ' + propertySlug + ' ref ' + ref);
            // Best-effort name split — guests usually paste "Miguel Cancino"
            const nameStr = (guestName || guestEmail).trim();
            const nameParts = nameStr.split(/\s+/);
            const firstname = nameParts[0] || 'Guest';
            const lastname  = nameParts.slice(1).join(' ') || '';
            const booking = {
              ref,
              property: propertyName || propertySlug,
              slug: propertySlug,
              conversationId: id,
              arrival:   enq.arrival   || '',
              departure: enq.departure || '',
              nights: '',
              guests: enq.guests || '',
              room: enq.cabin || '',
              // v73y: immutable snapshot of original enquiry values. The
              // `room`/`arrival`/`departure`/`guests` fields above get mutated
              // when offers are sent/revised, losing the original ask. This
              // snapshot lets the customer offer card flag changes vs what
              // they originally asked for. Only set at booking creation;
              // never updated after.
              enquiry_snapshot: {
                arrival:   enq.arrival   || '',
                departure: enq.departure || '',
                guests:    enq.guests    || '',
                cabin:     enq.cabin     || '',
                notes:     enq.notes     || '',
              },
              roomPrice: 0,
              totalAmount: 0,
              depositAmount: 0,
              firstname, lastname,
              email: guestEmail,
              phone: '',
              notes: enq.notes || '',
              status: 'enquiry',       // enquiry → offer_sent → confirmed/cancelled
              paymentStatus: 'none',
              createdAt: now,
              updatedAt: now
            };
            await env.DOSSIERS.put('booking:' + ref, JSON.stringify(booking));
            const bIdxRaw = await env.DOSSIERS.get('__bookings_index');
            const bRefs = bIdxRaw ? JSON.parse(bIdxRaw) : [];
            bRefs.push(ref);
            await env.DOSSIERS.put('__bookings_index', JSON.stringify(bRefs));
            console.log('[Conv create] stub booking ' + ref + ' saved + indexed. Total bookings now: ' + bRefs.length);
            // Link conversation → booking for later lookup from pp-conversations
            conv.bookingRef = ref;
            await env.DOSSIERS.put('conversation:' + id, JSON.stringify(conv));
          } catch (e) {
            console.error('[Conv create] booking-stub create FAILED for conv ' + id + ':', e && e.stack || e);
            // Non-fatal — conversation is already saved
          }

          // Update aggregate counters
          await recomputeUnreadCounters(env);

          // Email admin/partner notification
          if (env.RESEND_API_KEY && firstMessage && conv.notifyAdmin !== false) {
            try {
              const unsubUrl = `https://thebearing.io/api/notify-toggle?id=${id}&role=admin`;
              const adminRecipients = await loadNotificationRecipients(env);
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  from: 'The Bearing <bookings@thebearing.io>',
                  to: adminRecipients,
                  subject: `New enquiry — ${propertyName} from ${guestName || guestEmail}`,
                  text: `New enquiry received.\n\nGuest: ${guestName || guestEmail} (${guestEmail})\nProperty: ${propertyName}\n\nMessage:\n${firstMessage}\n\nReply at: https://thebearing.io/admin-conversations.html?id=${id}\n\n—\nMute email notifications for this conversation: ${unsubUrl}`
                })
              });
            } catch(e) { console.error('[Conv] Admin email error:', e.message); }
          }

          return jsonResponse({ ok: true, id, conversation: conv, messages });
        }

        // Send a message to existing conversation
        if (body.action === 'message') {
          const { id, role, text, senderName, senderEmail, updateEnquiry } = body;
          if (!id || !text) return jsonResponse({ error: 'id and text required' }, 400);

          const convRaw = await env.DOSSIERS.get('conversation:' + id);
          if (!convRaw) return jsonResponse({ error: 'conversation not found' }, 404);
          const conv = JSON.parse(convRaw);

          // v73o: refuse new messages on archived conversations. The frontend
          // disables the composer, but a direct API caller could otherwise
          // bypass that. Belt-and-suspenders.
          if (conv.status === 'archived') {
            return jsonResponse({ error: 'conversation is archived (read-only)' }, 409);
          }

          // v73u: hoisted flag — set inside the updateEnquiry block if a
          // pendingChangeRequest was stored. Used later to swap the email
          // subject/body so admin sees "Change request" vs generic "Reply".
          let storedChangeRequest = false;
          let changeRequestSummary = null;

          const msgsRaw = await env.DOSSIERS.get('conversation:' + id + ':messages');
          const messages = msgsRaw ? JSON.parse(msgsRaw) : [];

          const now = new Date().toISOString();
          const msg = {
            id: 'msg_' + Date.now(),
            role: role || 'guest',
            text, senderName: senderName || role,
            sentAt: now, readAt: null
          };
          messages.push(msg);

          // Update conversation metadata
          conv.lastMessageAt = now;
          conv.lastMessagePreview = text.substring(0, 100);
          if (role === 'guest') {
            conv.unreadAdmin = (conv.unreadAdmin || 0) + 1;
          } else {
            conv.unreadGuest = (conv.unreadGuest || 0) + 1;
            // Admin/partner replied — clear reminder flags so future staleness can re-trigger
            if (conv.reminders) {
              conv.reminders = { lastResetAt: now };
            }
          }

          // v73i: when a guest re-enquires on the same property, the
          // frontend includes updateEnquiry={arrival,departure,...} so we
          // can refresh the conversation's enquiry shape (visible on the
          // partner side panel) with the latest dates/room/guests. Only
          // overwrite fields that are non-empty so we don't blow away
          // info from the original enquiry if the user left a field blank.
          // v73r: when a guest follow-up message arrives on a conversation
          // whose linked booking already has an active offer, we MUST NOT
          // silently mutate the booking's dates/room/guests. That created a
          // data-corruption bug (v73q): the booking would show new dates while
          // the offer kept its original dates frozen, and the partner's
          // pp-bookings row would silently flip to the new dates with no
          // indication anything had changed. Worst case: customer pays the
          // deposit thinking they're getting the new dates, property confirms
          // for the original dates, no one notices until check-in.
          //
          // New policy: once an offer is in flight, the booking is locked.
          // Customer asks for new dates → store as `pendingChangeRequest` on
          // the booking, which the partner UI surfaces as an amber flag.
          // Partner clicks Revise → modal prefills from the change request
          // and shows a banner explaining what changed.
          //
          // updateEnquiry mutation of conv.enquiry is also blocked here so
          // the partner's side panel doesn't get re-written without context.
          if (updateEnquiry && typeof updateEnquiry === 'object' && role === 'guest') {
            let bookingHasActiveOffer = false;
            let bookingPath = null;
            if (conv.bookingRef) {
              try {
                bookingPath = 'booking:' + conv.bookingRef;
                const bRaw = await env.DOSSIERS.get(bookingPath);
                if (bRaw) {
                  const b = JSON.parse(bRaw);
                  // v73z: expanded guard with state-aware behavior. v73r
                  // covered only 'offer_sent' / 'pending' which left
                  // confirmed bookings open to silent date mutation.
                  //
                  // Three buckets:
                  //   (a) Fresh enquiry (status:'enquiry' && no offer history) →
                  //       mutate freely. Customer refining their original ask.
                  //   (b) Active offer (offer_sent / pending) → store
                  //       pendingChangeRequest. Partner will see "guest wants
                  //       these changes" and respond with revised offer.
                  //   (c) Confirmed / cancelled → do NOTHING. These bookings
                  //       are paid commitments or closed records; mutating or
                  //       even storing a change-request would be misleading.
                  //       Frontend should NOT route here \u2014 it should create a
                  //       new conversation/booking for separate stays. This
                  //       branch is belt-and-suspenders for direct API callers.
                  const isFreshEnquiry = b.status === 'enquiry' && !b.active_offer_id && !b.lastDeclinedOfferId;
                  const isOfferStage = !!b.active_offer_id && (b.status === 'offer_sent' || b.status === 'pending');
                  const isClosed = b.status === 'confirmed' || b.status === 'cancelled';

                  if (isClosed) {
                    // Bucket (c) — don't mutate, don't store change request.
                    // The guest probably wants a new separate booking. Frontend
                    // should have created a new conversation for this. Log
                    // explicitly so we notice if frontend filter regresses.
                    console.warn('[Conv msg] booking ' + conv.bookingRef + ' is closed (' + b.status + ') \u2014 ignoring updateEnquiry to prevent silent mutation. Guest message still appended; consider whether frontend should have created a new conversation instead.');
                    bookingHasActiveOffer = true; // suppress the fall-through mutation below
                  } else if (isOfferStage) {
                    // Bucket (b) — store pendingChangeRequest
                    bookingHasActiveOffer = true;
                    b.pendingChangeRequest = {
                      arrival:   updateEnquiry.arrival   || '',
                      departure: updateEnquiry.departure || '',
                      guests:    updateEnquiry.guests    || '',
                      cabin:     updateEnquiry.cabin     || '',
                      notes:     updateEnquiry.notes     || '',
                      requestedAt: now,
                      previousValues: {
                        arrival: b.arrival || '',
                        departure: b.departure || '',
                        guests: b.guests || '',
                        room: b.room || '',
                      }
                    };
                    b.updatedAt = now;
                    await env.DOSSIERS.put(bookingPath, JSON.stringify(b));
                    console.log('[Conv msg] booking ' + conv.bookingRef + ' has active offer \u2014 stored change request instead of mutating');
                    storedChangeRequest = true;
                    changeRequestSummary = b.pendingChangeRequest;
                  }
                  // Bucket (a) — isFreshEnquiry → falls through to mutation below
                }
              } catch (e) {
                console.error('[Conv msg] booking probe failed:', e);
              }
            }

            // Only mutate conv.enquiry + booking record when there's NO
            // active offer to protect. Same behavior as v73q for fresh
            // enquiries that haven't received an offer yet.
            if (!bookingHasActiveOffer) {
              conv.enquiry = conv.enquiry || {};
              ['arrival','departure','guests','cabin','notes'].forEach(function(k){
                if (updateEnquiry[k] != null && updateEnquiry[k] !== '') {
                  conv.enquiry[k] = updateEnquiry[k];
                }
              });
              if (conv.bookingRef) {
                try {
                  const bRaw = await env.DOSSIERS.get(bookingPath);
                  if (bRaw) {
                    const b = JSON.parse(bRaw);
                    if (updateEnquiry.arrival)   b.arrival   = updateEnquiry.arrival;
                    if (updateEnquiry.departure) b.departure = updateEnquiry.departure;
                    if (updateEnquiry.guests)    b.guests    = updateEnquiry.guests;
                    if (updateEnquiry.cabin)     b.room      = updateEnquiry.cabin;
                    if (updateEnquiry.notes)     b.notes     = updateEnquiry.notes;
                    b.updatedAt = now;
                    await env.DOSSIERS.put(bookingPath, JSON.stringify(b));
                  }
                } catch(e) {
                  console.error('[Conv msg] booking-stub refresh failed:', e);
                }
              }
            }
          }

          await env.DOSSIERS.put('conversation:' + id, JSON.stringify(conv));
          await env.DOSSIERS.put('conversation:' + id + ':messages', JSON.stringify(messages));

          // Record last-reply timestamps for presence tracking
          const nowMs = Date.now();
          if (role === 'admin' || role === 'partner') {
            await env.DOSSIERS.put('lastreply:property:' + conv.propertySlug, String(nowMs), { expirationTtl: 2592000 });
          } else if (role === 'guest') {
            const guestKey = conv.guestId || conv.guestEmail;
            if (guestKey) await env.DOSSIERS.put('lastreply:guest:' + guestKey, String(nowMs), { expirationTtl: 2592000 });
          }

          // Update aggregate counters
          await recomputeUnreadCounters(env);

          // Email notification to the other party
          if (env.RESEND_API_KEY) {
            try {
              if (role === 'admin' || role === 'partner') {
                // Notify guest — only if guest hasn't muted
                if (conv.notifyGuest !== false) {
                  const replyUrl = `https://thebearing.io/conversations.html?id=${id}`;
                  const unsubUrl = `https://thebearing.io/api/notify-toggle?id=${id}&role=guest`;
                  const displaySender = senderName || conv.propertyName;
                  await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      from: `${conv.propertyName} via The Bearing <bookings@thebearing.io>`,
                      to: [conv.guestEmail],
                      reply_to: `reply+${id}@replies.thebearing.io`,
                      subject: `New message about your ${conv.propertyName} enquiry`,
                      text: `${displaySender} sent you a message on The Bearing:\n\n"${text}"\n\nYou can reply to this email or view the conversation here:\n${replyUrl}\n\n— The Bearing\nhttps://thebearing.io\n\n—\nMute email notifications for this conversation: ${unsubUrl}`
                    })
                  });
                }
              } else {
                // Notify admin — only if admin hasn't muted
                if (conv.notifyAdmin !== false) {
                  const unsubUrl = `https://thebearing.io/api/notify-toggle?id=${id}&role=admin`;
                  const adminRecipients = await loadNotificationRecipients(env);

                  // v73u: distinct subject/body when this message triggered a
                  // pendingChangeRequest store (guest sent updateEnquiry on a
                  // booking that already has an active offer). Helps admin/
                  // partner triage their inbox: "Change request" is
                  // categorically more urgent than a chatty reply.
                  let subject, bodyText;
                  if (storedChangeRequest && changeRequestSummary) {
                    const fmt = function(s){ try { return new Date(s.length===10?s+'T00:00':s).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); } catch(_){ return s; } };
                    const cr = changeRequestSummary;
                    const prev = cr.previousValues || {};
                    const changeLines = [];
                    if (cr.arrival && cr.departure && (cr.arrival !== prev.arrival || cr.departure !== prev.departure)) {
                      changeLines.push('Dates: ' + (prev.arrival && prev.departure ? (fmt(prev.arrival) + ' → ' + fmt(prev.departure) + '   →   ') : '') + fmt(cr.arrival) + ' → ' + fmt(cr.departure));
                    }
                    if (cr.guests && cr.guests !== prev.guests) {
                      changeLines.push('Guests: ' + (prev.guests || '(unset)') + '   →   ' + cr.guests);
                    }
                    if (cr.cabin && cr.cabin !== prev.room) {
                      changeLines.push('Room: ' + (prev.room || '(unset)') + '   →   ' + cr.cabin);
                    }
                    subject = `Change request from ${conv.guestName} — ${conv.propertyName}`;
                    bodyText = `${conv.guestName} requested a change to the active offer on ${conv.propertyName}.\n\n` +
                               (changeLines.length ? changeLines.join('\n') + '\n\n' : '') +
                               `Their message:\n\n"${text}"\n\n` +
                               `Action: open the booking in the partner portal, click "Revise offer" — the form will pre-fill with the requested values.\n\n` +
                               `View conversation: https://thebearing.io/admin-conversations.html?id=${id}\n\n` +
                               `—\nMute email notifications for this conversation: ${unsubUrl}`;
                  } else {
                    subject = `Reply from ${conv.guestName} — ${conv.propertyName}`;
                    bodyText = `${conv.guestName} replied:\n\n"${text}"\n\nView conversation: https://thebearing.io/admin-conversations.html?id=${id}\n\n—\nMute email notifications for this conversation: ${unsubUrl}`;
                  }

                  await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      from: 'The Bearing <bookings@thebearing.io>',
                      to: adminRecipients,
                      subject: subject,
                      text: bodyText,
                    })
                  });
                }
              }
            } catch(e) { console.error('[Conv] Notify email error:', e.message); }
          }

          return jsonResponse({ ok: true, message: msg });
        }

        // Toggle a reaction on a specific message
        // body: { action:'reaction', id (conv), messageId, emoji, role, userId }
        if (body.action === 'reaction') {
          const { id, messageId, emoji, role, userId } = body;
          if (!id || !messageId || !emoji) return jsonResponse({ error: 'id, messageId, emoji required' }, 400);
          const msgsRaw = await env.DOSSIERS.get('conversation:' + id + ':messages');
          if (!msgsRaw) return jsonResponse({ error: 'not found' }, 404);
          const messages = JSON.parse(msgsRaw);
          const msg = messages.find(m => m.id === messageId);
          if (!msg) return jsonResponse({ error: 'message not found' }, 404);
          msg.reactions = msg.reactions || {};
          msg.reactions[emoji] = msg.reactions[emoji] || [];
          const who = userId || role || 'unknown';
          const existingIdx = msg.reactions[emoji].indexOf(who);
          if (existingIdx === -1) {
            msg.reactions[emoji].push(who);
          } else {
            msg.reactions[emoji].splice(existingIdx, 1);
            if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
          }
          await env.DOSSIERS.put('conversation:' + id + ':messages', JSON.stringify(messages));
          return jsonResponse({ ok: true, reactions: msg.reactions });
        }

        return jsonResponse({ error: 'invalid action' }, 400);
      }

      // PATCH — mark messages read, update status
      if (request.method === 'PATCH') {
        let body;
        try { body = await request.json(); }
        catch(e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
        const { id, markReadFor, status } = body;
        if (!id) return jsonResponse({ error: 'id required' }, 400);
        const convRaw = await env.DOSSIERS.get('conversation:' + id);
        if (!convRaw) return jsonResponse({ error: 'not found' }, 404);
        const conv = JSON.parse(convRaw);
        if (markReadFor === 'admin') conv.unreadAdmin = 0;
        if (markReadFor === 'guest') conv.unreadGuest = 0;
        if (status) conv.status = status;
        await env.DOSSIERS.put('conversation:' + id, JSON.stringify(conv));
        await recomputeUnreadCounters(env);
        return jsonResponse({ ok: true });
      }
    }

    // ── /api/saved-replies ────────────────────────────────────────
    // Admin's saved reply templates, stored globally in KV.
    // GET    → returns { replies: [{id, label, text}] }
    // POST   → upsert; body: { id?, label, text }
    // DELETE ?id=X → remove
    if (url.pathname === '/api/saved-replies') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);
      const KEY = '__saved_replies';

      if (request.method === 'GET') {
        const raw = await env.DOSSIERS.get(KEY);
        return jsonResponse({ replies: raw ? JSON.parse(raw) : [] });
      }
      if (request.method === 'POST') {
        if (!(await isAdmin())) return adminDenied();
        let body;
        try { body = await request.json(); } catch(e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
        if (!body.label || !body.text) return jsonResponse({ error: 'label and text required' }, 400);
        const raw = await env.DOSSIERS.get(KEY);
        const replies = raw ? JSON.parse(raw) : [];
        if (body.id) {
          const idx = replies.findIndex(r => r.id === body.id);
          if (idx >= 0) {
            replies[idx] = { id: body.id, label: body.label, text: body.text };
          } else {
            replies.push({ id: body.id, label: body.label, text: body.text });
          }
        } else {
          replies.push({ id: 'rep_' + Date.now(), label: body.label, text: body.text });
        }
        await env.DOSSIERS.put(KEY, JSON.stringify(replies));
        return jsonResponse({ ok: true, replies });
      }
      if (request.method === 'DELETE') {
        if (!(await isAdmin())) return adminDenied();
        const id = url.searchParams.get('id');
        if (!id) return jsonResponse({ error: 'id required' }, 400);
        const raw = await env.DOSSIERS.get(KEY);
        const replies = raw ? JSON.parse(raw) : [];
        const filtered = replies.filter(r => r.id !== id);
        await env.DOSSIERS.put(KEY, JSON.stringify(filtered));
        return jsonResponse({ ok: true, replies: filtered });
      }
      return new Response('Method not allowed', { status: 405 });
    }

    // ── /api/presence ─────────────────────────────────────────────
    // Heartbeat-based online presence. Clients POST every 30s.
    // POST { role: 'admin'|'partner'|'guest', slug?: string, guestId?: string }
    // GET ?slug=X returns property's last_seen for guest view
    // GET ?guestId=X returns guest's last_seen for admin/partner view
    if (url.pathname === '/api/presence') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch(e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
        const now = Date.now();
        let key = null;
        if (body.role === 'admin') key = 'presence:admin';
        else if (body.role === 'partner' && body.slug) key = 'presence:partner:' + body.slug;
        else if (body.role === 'guest' && body.guestId) key = 'presence:guest:' + body.guestId;
        if (!key) return jsonResponse({ error: 'role + identifier required' }, 400);
        await env.DOSSIERS.put(key, String(now), { expirationTtl: 3600 });
        return jsonResponse({ ok: true, ts: now });
      }

      if (request.method === 'GET') {
        const slug = url.searchParams.get('slug');
        const guestId = url.searchParams.get('guestId');
        const result = {};

        if (slug) {
          // Last seen for property = max(partner heartbeat, admin heartbeat, last partner/admin reply)
          const partnerRaw = await env.DOSSIERS.get('presence:partner:' + slug);
          const adminRaw = await env.DOSSIERS.get('presence:admin');
          const lastReplyRaw = await env.DOSSIERS.get('lastreply:property:' + slug);
          const candidates = [
            partnerRaw ? parseInt(partnerRaw) : 0,
            adminRaw ? parseInt(adminRaw) : 0,
            lastReplyRaw ? parseInt(lastReplyRaw) : 0
          ];
          result.lastSeen = Math.max(...candidates) || null;
          result.online = result.lastSeen && (Date.now() - result.lastSeen < 60000);
        }

        if (guestId) {
          const guestRaw = await env.DOSSIERS.get('presence:guest:' + guestId);
          const lastReplyRaw = await env.DOSSIERS.get('lastreply:guest:' + guestId);
          const candidates = [
            guestRaw ? parseInt(guestRaw) : 0,
            lastReplyRaw ? parseInt(lastReplyRaw) : 0
          ];
          result.guestLastSeen = Math.max(...candidates) || null;
          result.guestOnline = result.guestLastSeen && (Date.now() - result.guestLastSeen < 60000);
        }

        return jsonResponse(result);
      }

      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    // ── /api/notify-toggle ────────────────────────────────────────
    // Toggle email notifications on/off per conversation per role.
    // GET (from email link): shows confirmation page and toggles
    // POST (from in-app): JSON body { id, role, enabled } returns JSON
    if (url.pathname === '/api/notify-toggle') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      let id, role, enabled, isGet;

      if (request.method === 'GET') {
        isGet = true;
        id = url.searchParams.get('id');
        role = url.searchParams.get('role');
        // GET defaults to flipping (mute)
        enabled = url.searchParams.get('enabled');
      } else if (request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        id = b.id; role = b.role; enabled = b.enabled;
      } else {
        return jsonResponse({ error: 'GET or POST only' }, 405);
      }

      if (!id || !role) {
        return isGet
          ? new Response('Missing id or role', { status: 400 })
          : jsonResponse({ error: 'id and role required' }, 400);
      }
      if (!['admin', 'partner', 'guest'].includes(role)) {
        return isGet
          ? new Response('Invalid role', { status: 400 })
          : jsonResponse({ error: 'role must be admin/partner/guest' }, 400);
      }

      const convRaw = await env.DOSSIERS.get('conversation:' + id);
      if (!convRaw) {
        return isGet
          ? new Response('Conversation not found', { status: 404 })
          : jsonResponse({ error: 'conversation not found' }, 404);
      }
      const conv = JSON.parse(convRaw);

      const flagKey = role === 'admin' ? 'notifyAdmin'
                    : role === 'partner' ? 'notifyPartner'
                    : 'notifyGuest';

      // Determine new value
      let newValue;
      if (enabled === undefined || enabled === null || enabled === '') {
        // GET with no enabled param = toggle (mute by default)
        newValue = conv[flagKey] === false ? true : false;
      } else {
        newValue = (enabled === true || enabled === 'true' || enabled === '1');
      }

      conv[flagKey] = newValue;
      await env.DOSSIERS.put('conversation:' + id, JSON.stringify(conv));

      if (isGet) {
        // Show a friendly HTML confirmation
        const status = newValue ? 'enabled' : 'muted';
        const flipLink = `/api/notify-toggle?id=${id}&role=${role}&enabled=${!newValue}`;
        const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Notifications ${status} — The Bearing</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500&family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  body{margin:0;background:#faf7f1;font-family:Geist,sans-serif;color:#1e1810;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;}
  .card{max-width:480px;text-align:center;background:#fff;padding:48px 36px;border-radius:16px;border:1px solid rgba(80,60,30,.08);}
  h1{font-family:'Cormorant Garamond',serif;font-weight:500;font-size:1.8rem;margin:0 0 12px;}
  p{font-size:.92rem;line-height:1.6;color:#5a4f43;margin:8px 0 24px;}
  .pill{display:inline-block;padding:6px 14px;border-radius:100px;background:${newValue?'#e8f4ea':'#fdecea'};color:${newValue?'#1b6a32':'#a23226'};font-size:.8rem;font-weight:500;margin-bottom:16px;}
  a.undo{display:inline-block;padding:10px 20px;background:#1e1810;color:#fff;text-decoration:none;border-radius:100px;font-size:.85rem;font-weight:500;}
  .conv{font-size:.78rem;color:#9a8e80;margin-top:32px;}
</style></head>
<body><div class="card">
  <div class="pill">Email notifications ${status}</div>
  <h1>${newValue ? 'You\u2019ll hear from us' : 'You won\u2019t hear from us'}</h1>
  <p>${newValue
    ? `You'll receive email notifications for new messages on this conversation about ${conv.propertyName||'your enquiry'}.`
    : `We won't email you about new messages on this conversation about ${conv.propertyName||'your enquiry'}. You can still view replies anytime on The Bearing.`}</p>
  <a class="undo" href="${flipLink}">${newValue ? 'Mute notifications' : 'Re-enable notifications'}</a>
  <div class="conv">Conversation #${id.substring(0,16)}\u2026</div>
</div></body></html>`;
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      return jsonResponse({ ok: true, id, role, [flagKey]: newValue });
    }


    // Resend inbound webhook — parses email replies and saves to conversation
    // Setup: Resend dashboard → Domains → thebearing.io → enable Receiving
    // Then add webhook endpoint: https://thebearing.io/api/inbound-email
    if (url.pathname === '/api/inbound-email') {
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      let body;
      try { body = await request.json(); }
      catch(e) { return jsonResponse({ error: 'invalid JSON' }, 400); }

      // Log full payload for debugging (visible in Cloudflare Worker logs)
      console.log('[Inbound] Received:', JSON.stringify(body).substring(0, 500));

      // Collect all possible "to" addresses from various payload shapes
      // Resend may send: body.to, body.recipient, body.envelope.to, body.data.to
      const toAddresses = [];
      function collectAddresses(value) {
        if (!value) return;
        if (typeof value === 'string') toAddresses.push(value);
        else if (Array.isArray(value)) value.forEach(collectAddresses);
        else if (value.email) toAddresses.push(value.email);
        else if (value.address) toAddresses.push(value.address);
      }
      collectAddresses(body.to);
      collectAddresses(body.recipient);
      if (body.envelope) collectAddresses(body.envelope.to);
      if (body.data) {
        collectAddresses(body.data.to);
        collectAddresses(body.data.recipient);
        if (body.data.envelope) collectAddresses(body.data.envelope.to);
      }

      let convId = null;
      for (const addr of toAddresses) {
        // v73w: accept both legacy `reply+X@thebearing.io` (from emails sent before
        // v73w) and new `reply+X@replies.thebearing.io` (post-v73w when root MX is
        // pointed at Google). Subdomain is the going-forward path; root form may
        // continue arriving briefly during the Phase 5 MX cutover.
        const m = String(addr).match(/reply\+([a-zA-Z0-9_]+)@(?:replies\.)?thebearing\.io/i);
        if (m) { convId = m[1]; break; }
      }

      if (!convId) {
        console.log('[Inbound] No conv ID found. Addresses:', toAddresses);
        return jsonResponse({ error: 'no conversation ID in recipient', addresses: toAddresses }, 400);
      }

      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      const convRaw = await env.DOSSIERS.get('conversation:' + convId);
      if (!convRaw) return jsonResponse({ error: 'conversation not found', convId }, 404);
      const conv = JSON.parse(convRaw);

      // Get email body — try multiple field names in the webhook payload
      let text = body.text || body.plain || (body.data && body.data.text) || (body.data && body.data.plain) || '';
      let html = body.html || (body.data && body.data.html) || '';

      // If body isn't in the webhook payload, fetch it from Resend's Receiving API
      // Endpoint: GET https://api.resend.com/emails/receiving/{email_id}
      const emailId = (body.data && body.data.email_id) || body.email_id;
      if (!text && !html && emailId && env.RESEND_API_KEY) {
        try {
          console.log('[Inbound] Fetching email body via Receiving API for:', emailId);
          const apiResp = await fetch('https://api.resend.com/emails/receiving/' + emailId, {
            headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY }
          });
          if (apiResp.ok) {
            const emailData = await apiResp.json();
            text = emailData.text || '';
            html = emailData.html || '';
            console.log('[Inbound] Got body, text length:', text.length, 'html length:', html.length);
          } else {
            const errText = await apiResp.text();
            console.log('[Inbound] API fetch failed:', apiResp.status, errText.substring(0, 200));
          }
        } catch (e) {
          console.log('[Inbound] API fetch error:', e.message);
        }
      }

      // Strip HTML if only HTML is available — preserve line breaks
      if (!text && html) {
        text = html
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, '\n')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\n\s*\n\s*\n+/g, '\n\n')
          .trim();
      }
      text = text.trim();

      // Strip quoted reply content (lines starting with >)
      text = text.split('\n')
        .filter(line => !line.trim().startsWith('>'))
        .join('\n')
        .trim();

      // Strip "On <date/day>... wrote:" attribution — works whether or not it's on its own line
      const attribMatch = text.match(/\s*On\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})[\s\S]{0,300}?wrote:/);
      if (attribMatch && typeof attribMatch.index === 'number') {
        text = text.substring(0, attribMatch.index).trim();
      }

      // Strip our own sender markers like "Nour El Nil via The Bearing <bookings@thebearing.io>"
      const bearingMatch = text.match(/\s+(Nour El Nil|The Bearing)[\s\S]{0,100}?(via The Bearing|<bookings@thebearing)/);
      if (bearingMatch && typeof bearingMatch.index === 'number') {
        text = text.substring(0, bearingMatch.index).trim();
      }

      // Strip trailing quote artifacts
      text = text.replace(/\s+>+\s*$/g, '').trim();

      // Strip common signature/quote separators
      const sigSeparators = ['\n-- \n', '\n--\n', '\n— The Bearing', '\nSent from my', '\n________', '\nFrom:'];
      for (const sep of sigSeparators) {
        const idx = text.indexOf(sep);
        if (idx > 20) { text = text.substring(0, idx).trim(); break; }
      }

      text = text.trim();

      if (!text || text.length < 2) {
        console.log('[Inbound] Empty reply after stripping. Full body received:', JSON.stringify(body));
        return jsonResponse({ 
          ok: true, 
          skipped: 'empty reply', 
          convId,
          debug: {
            receivedKeys: Object.keys(body),
            dataKeys: body.data ? Object.keys(body.data) : null,
            rawTextLength: (body.text||(body.data&&body.data.text)||'').length,
            rawHtmlLength: (body.html||(body.data&&body.data.html)||'').length,
            samplePayload: JSON.stringify(body).substring(0, 1000)
          }
        });
      }

      // Save message as guest reply
      const msgsRaw = await env.DOSSIERS.get('conversation:' + convId + ':messages');
      const messages = msgsRaw ? JSON.parse(msgsRaw) : [];
      const now = new Date().toISOString();
      const fromAddr = body.from || (body.data && body.data.from) || '';
      const msg = {
        id: 'msg_' + Date.now(),
        role: 'guest',
        text,
        senderName: conv.guestName || fromAddr || 'Guest',
        sentAt: now,
        readAt: null,
        source: 'email'
      };
      messages.push(msg);

      conv.lastMessageAt = now;
      conv.lastMessagePreview = text.substring(0, 100);
      conv.unreadAdmin = (conv.unreadAdmin || 0) + 1;

      await env.DOSSIERS.put('conversation:' + convId, JSON.stringify(conv));
      await env.DOSSIERS.put('conversation:' + convId + ':messages', JSON.stringify(messages));
      await recomputeUnreadCounters(env);

      // Record guest's lastreply timestamp for presence
      const nowMs = Date.now();
      const guestKey = conv.guestId || conv.guestEmail;
      if (guestKey) {
        await env.DOSSIERS.put('lastreply:guest:' + guestKey, String(nowMs), { expirationTtl: 2592000 });
      }

      // Notify admin
      if (env.RESEND_API_KEY && conv.notifyAdmin !== false) {
        try {
          const unsubUrl = `https://thebearing.io/api/notify-toggle?id=${convId}&role=admin`;
          const adminRecipients = await loadNotificationRecipients(env);
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'The Bearing <bookings@thebearing.io>',
              to: adminRecipients,
              subject: `Email reply from ${conv.guestName} — ${conv.propertyName}`,
              text: `${conv.guestName} replied via email:\n\n"${text}"\n\nView conversation: https://thebearing.io/admin-conversations.html\n\n—\nMute email notifications for this conversation: ${unsubUrl}`
            })
          });
        } catch(e) { console.error('[Inbound] Notify error:', e.message); }
      }

      return jsonResponse({ ok: true, convId, messageId: msg.id });
    }

    // ── /api/members ──────────────────────────────────────────────
    if (url.pathname === '/api/members') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);
      if (request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (id) {
          const raw = await env.DOSSIERS.get('member:' + id);
          const data = raw ? JSON.parse(raw) : null;
          return jsonResponse({ id, data, exists: !!data });
        }
        const rawIndex = await env.DOSSIERS.get('__members_index');
        const ids = rawIndex ? JSON.parse(rawIndex) : [];
        const members = await Promise.all(ids.map(async (uid) => {
          const raw = await env.DOSSIERS.get('member:' + uid);
          return raw ? { id: uid, ...JSON.parse(raw) } : null;
        }));
        return jsonResponse({ members: members.filter(Boolean) });
      }
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
        if (!body.id) return jsonResponse({ error: 'id required' }, 400);
        // Merge into existing record — admin edits must not wipe fields written by the Clerk webhook
        const existingRaw = await env.DOSSIERS.get('member:' + body.id);
        const existing = existingRaw ? JSON.parse(existingRaw) : {};
        const member = {
          // Webhook-owned fields: keep existing if present, fall back to body, then defaults
          id: body.id,
          email: existing.email || body.email || '',
          name: body.name !== undefined ? body.name : (existing.name || ''),
          provider: existing.provider || body.provider || 'email',
          avatar: existing.avatar || body.avatar || '',
          joined_at: existing.joined_at || body.joined_at || new Date().toISOString(),
          // Admin-editable fields: body wins when present, otherwise keep existing
          tier: body.tier !== undefined ? body.tier : (existing.tier || 'member'),
          location: body.location !== undefined ? body.location : (existing.location || ''),
          bookings: body.bookings !== undefined ? body.bookings : (existing.bookings || 0),
          ltv: body.ltv !== undefined ? body.ltv : (existing.ltv || 0),
          preferences: body.preferences !== undefined ? body.preferences : (existing.preferences || {}),
          notes: body.notes !== undefined ? body.notes : (existing.notes || ''),
          // System-managed
          last_active: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        await env.DOSSIERS.put('member:' + body.id, JSON.stringify(member));
        const rawIndex = await env.DOSSIERS.get('__members_index');
        let ids = rawIndex ? JSON.parse(rawIndex) : [];
        if (!ids.includes(body.id)) { ids.push(body.id); await env.DOSSIERS.put('__members_index', JSON.stringify(ids)); }
        return jsonResponse({ ok: true, member });
      }
      if (request.method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) return jsonResponse({ error: 'id required' }, 400);
        await env.DOSSIERS.delete('member:' + id);
        const rawIndex = await env.DOSSIERS.get('__members_index');
        let ids = rawIndex ? JSON.parse(rawIndex) : [];
        ids = ids.filter(i => i !== id);
        await env.DOSSIERS.put('__members_index', JSON.stringify(ids));
        return jsonResponse({ ok: true, deleted: id });
      }
    }

    // ── /api/clerk-webhook ────────────────────────────────────────
    if (url.pathname === '/api/clerk-webhook') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      const webhookSecret = env.CLERK_WEBHOOK_SECRET;
      if (webhookSecret) {
        const svixId = request.headers.get('svix-id');
        const svixTimestamp = request.headers.get('svix-timestamp');
        const svixSignature = request.headers.get('svix-signature');
        if (!svixId || !svixTimestamp || !svixSignature) return jsonResponse({ error: 'Missing svix headers' }, 400);
        const ts = parseInt(svixTimestamp);
        if (Math.abs(Date.now() / 1000 - ts) > 300) return jsonResponse({ error: 'Timestamp too old' }, 400);
        const body = await request.text();
        const signedContent = svixId + '.' + svixTimestamp + '.' + body;
        const secretBytes = Uint8Array.from(atob(webhookSecret.replace('whsec_', '')), c => c.charCodeAt(0));
        const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        const signatures = svixSignature.split(' ').map(s => s.split(',')[1]).filter(Boolean);
        const msgBytes = new TextEncoder().encode(signedContent);
        let verified = false;
        for (const sig of signatures) {
          const sigBytes = Uint8Array.from(atob(sig), c => c.charCodeAt(0));
          if (await crypto.subtle.verify('HMAC', key, sigBytes, msgBytes)) { verified = true; break; }
        }
        if (!verified) return jsonResponse({ error: 'Invalid signature' }, 401);
        let event;
        try { event = JSON.parse(body); } catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
        await handleClerkEvent(event, env);
      } else {
        let event;
        try { event = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
        await handleClerkEvent(event, env);
      }
      return jsonResponse({ ok: true });
    }

    // ── /api/settings/allowlist-public ─────────────────────────────
    // Returns the merged admin allowlist (baseline + KV extras) WITHOUT auth.
    // This is read by assets/admin-gate.js on every admin page load so the
    // client gate can authorize additional admins added via the settings UI.
    // No sensitive data: emails are admin login addresses, not customer data.
    if (url.pathname === '/api/settings/allowlist-public') {
      if (request.method !== 'GET') {
        return jsonResponse({ error: 'GET only' }, 405);
      }
      const extras = await loadAllowlistExtras(env);
      const merged = ADMIN_EMAILS_BASELINE.concat(extras);
      const seen = {}; const out = [];
      merged.forEach(function(e) {
        const lc = String(e || '').toLowerCase().trim();
        if (lc && !seen[lc]) { seen[lc] = 1; out.push(lc); }
      });
      return jsonResponse({ allowlist: out });
    }

    // ── /api/settings ──────────────────────────────────────────────
    // GET → current settings (notification recipients, admin allowlist extras)
    // POST → update settings { type: 'notifications'|'allowlist', ... }
    // Both admin-gated.
    if (url.pathname === '/api/settings') {
      if (!(await isAdmin())) return adminDenied();
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      if (request.method === 'GET') {
        const notifRaw = await env.DOSSIERS.get('__settings:notifications');
        const allowRaw = await env.DOSSIERS.get('__settings:allowlist');
        let notifications = { recipients: [] };
        let allowlist = { emails: [] };
        try { if (notifRaw) notifications = JSON.parse(notifRaw); } catch(_) {}
        try { if (allowRaw) allowlist = JSON.parse(allowRaw); } catch(_) {}
        return jsonResponse({
          ok: true,
          notifications: {
            recipients: Array.isArray(notifications.recipients) ? notifications.recipients : [],
            baseline: BASELINE_NOTIFICATION_RECIPIENT
          },
          allowlist: {
            emails: Array.isArray(allowlist.emails) ? allowlist.emails : [],
            baseline: ADMIN_EMAILS_BASELINE
          }
        });
      }

      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); }
        catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }

        const type = body && body.type;
        if (type === 'notifications') {
          const list = Array.isArray(body.recipients) ? body.recipients : [];
          const cleaned = []; const seen = {};
          list.forEach(function(e) {
            const lc = String(e || '').toLowerCase().trim();
            // Basic email shape check — anything@anything.anything
            if (lc && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lc) && !seen[lc]) {
              seen[lc] = 1;
              cleaned.push(lc);
            }
          });
          await env.DOSSIERS.put('__settings:notifications', JSON.stringify({
            recipients: cleaned,
            updatedAt: new Date().toISOString()
          }));
          return jsonResponse({ ok: true, recipients: cleaned });
        }

        if (type === 'allowlist') {
          const list = Array.isArray(body.emails) ? body.emails : [];
          const cleaned = []; const seen = {};
          // Reject baseline addresses — they're hardcoded and never need to be stored
          const baselineLc = ADMIN_EMAILS_BASELINE.map(function(e) { return e.toLowerCase(); });
          list.forEach(function(e) {
            const lc = String(e || '').toLowerCase().trim();
            if (lc && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lc) && !seen[lc] && baselineLc.indexOf(lc) === -1) {
              seen[lc] = 1;
              cleaned.push(lc);
            }
          });
          await env.DOSSIERS.put('__settings:allowlist', JSON.stringify({
            emails: cleaned,
            updatedAt: new Date().toISOString()
          }));
          return jsonResponse({ ok: true, emails: cleaned });
        }

        return jsonResponse({ error: 'type must be "notifications" or "allowlist"' }, 400);
      }

      return jsonResponse({ error: 'GET or POST only' }, 405);
    }

    // ── /api/test-email ────────────────────────────────────────────
    // v73v: admin-gated. Fires a single test email through Resend to the
    // configured notification recipients. Returns Resend's response status
    // + email id (or error) so admin can confirm delivery without running
    // the full booking flow. Most useful when diagnosing "why am I not
    // getting emails" — gives a clean cause for silent failures.
    if (url.pathname === '/api/test-email') {
      if (!(await isAdmin())) return adminDenied();
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

      if (!env.RESEND_API_KEY) {
        return jsonResponse({ error: 'RESEND_API_KEY not configured on worker' }, 503);
      }

      const recipients = await loadNotificationRecipients(env);
      const now = new Date().toISOString();

      try {
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'The Bearing <bookings@thebearing.io>',
            to: recipients,
            subject: 'Test email from The Bearing admin · ' + now.slice(0,16),
            text: 'This is a diagnostic test email triggered from admin-settings.\n\nIf you can read this, your Resend integration is delivering successfully to the configured recipients.\n\nTimestamp: ' + now + '\nRecipients: ' + recipients.join(', '),
          }),
        });
        let body = null;
        try { body = await resp.json(); } catch(_) {}
        if (resp.ok) {
          return jsonResponse({
            ok: true,
            recipients: recipients,
            resendStatus: resp.status + ' OK',
            resendId: body && body.id || null,
          });
        } else {
          return jsonResponse({
            ok: false,
            recipients: recipients,
            resendStatus: resp.status,
            resendError: (body && (body.message || body.error)) || ('HTTP ' + resp.status),
            error: 'Resend rejected the send: ' + ((body && (body.message || body.error)) || 'HTTP ' + resp.status),
          });
        }
      } catch (e) {
        return jsonResponse({ ok: false, error: 'Network/runtime error: ' + (e && e.message || String(e)) }, 500);
      }
    }

    // ── /api/health ────────────────────────────────────────────────
    // Admin-gated. Reports the status of dependent systems so the founder can
    // diagnose issues from the admin-settings page without hitting each service.
    // Each check is wrapped in its own try/catch so one failure doesn't break others.
    if (url.pathname === '/api/health') {
      if (!(await isAdmin())) return adminDenied();
      if (request.method !== 'GET') return jsonResponse({ error: 'GET only' }, 405);

      const checks = {};

      // KV
      try {
        const ping = await env.DOSSIERS.get('__property_index');
        checks.kv = {
          ok: true,
          status: 'connected',
          detail: ping ? 'index present' : 'index empty (no properties)',
          binding: 'DOSSIERS'
        };
      } catch(e) {
        checks.kv = { ok: false, status: 'error', detail: String(e && e.message || e) };
      }

      // Resend
      if (!env.RESEND_API_KEY) {
        checks.resend = {
          ok: false,
          status: 'not configured',
          detail: 'RESEND_API_KEY secret is not set on the worker'
        };
      } else {
        try {
          // Resend has no public health endpoint; the cheapest valid call is
          // GET /domains which returns the configured sending domains. Status 200
          // ⇒ key valid and reachable. 401 ⇒ key invalid. Network error ⇒ unreachable.
          const resp = await fetch('https://api.resend.com/domains', {
            headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}` }
          });
          if (resp.ok) {
            let domainCount = null;
            let domainSummary = '';
            // v73v: surface whether the `thebearing.io` sender domain is
            // actually verified. The most common cause of silent email
            // failures: API key works, code attempts to send from
            // `bookings@thebearing.io`, but Resend rejects with 403 because
            // the domain isn't verified — and our worker's .catch() swallows
            // the error silently. This check makes that visible in
            // admin-settings without needing to scroll worker logs.
            try {
              const j = await resp.json();
              if (Array.isArray(j && j.data)) {
                domainCount = j.data.length;
                const ours = j.data.find(function(d) { return d && (d.name === 'thebearing.io'); });
                if (ours) {
                  const status = (ours.status || 'unknown').toLowerCase();
                  if (status === 'verified') {
                    domainSummary = 'thebearing.io verified — sending OK';
                  } else {
                    domainSummary = 'thebearing.io status: ' + status + ' — emails from bookings@thebearing.io WILL FAIL';
                  }
                } else if (domainCount === 0) {
                  domainSummary = 'NO sending domains configured — every send will fail';
                } else {
                  domainSummary = 'thebearing.io NOT in configured domains — every send will fail';
                }
              }
            } catch(_) {}
            checks.resend = {
              ok: domainSummary.indexOf('OK') !== -1 || (domainCount === null),
              status: 'connected',
              detail: domainSummary || (domainCount === null ? 'API key valid' : (domainCount + ' sending domain(s) configured'))
            };
          } else {
            checks.resend = {
              ok: false,
              status: 'auth error',
              detail: 'Resend returned HTTP ' + resp.status + ' — check the API key'
            };
          }
        } catch(e) {
          checks.resend = { ok: false, status: 'unreachable', detail: String(e && e.message || e) };
        }
      }

      // Vectorize
      if (!env.VECTORIZE) {
        checks.vectorize = {
          ok: false,
          status: 'not bound',
          detail: 'VECTORIZE binding missing from wrangler.toml or Pages config'
        };
      } else {
        try {
          // describe() returns dimensions/metric/vectorsCount for the index
          const info = await env.VECTORIZE.describe();
          const dims = info && (info.config && info.config.dimensions || info.dimensions);
          const count = info && (info.vectorsCount !== undefined ? info.vectorsCount : info.vectors);
          checks.vectorize = {
            ok: true,
            status: 'connected',
            detail: 'index reachable' + (dims ? ` (${dims} dims)` : '') + (count !== undefined ? `, ${count} vectors` : ''),
            indexName: 'thebearing-properties'
          };
        } catch(e) {
          checks.vectorize = { ok: false, status: 'error', detail: String(e && e.message || e) };
        }
      }

      // Workers AI binding (embeddings model)
      if (!env.AI) {
        checks.ai = {
          ok: false,
          status: 'not bound',
          detail: 'AI binding missing from wrangler.toml or Pages config'
        };
      } else {
        checks.ai = {
          ok: true,
          status: 'bound',
          detail: 'Workers AI available (model: @cf/baai/bge-base-en-v1.5)'
        };
      }

      // Anthropic key (Envoy)
      checks.anthropic = env.ANTHROPIC_API_KEY
        ? { ok: true, status: 'configured', detail: 'ANTHROPIC_API_KEY secret is set' }
        : { ok: false, status: 'not configured', detail: 'ANTHROPIC_API_KEY secret missing — /api/envoy will fail' };

      // Clerk
      checks.clerk = env.CLERK_SECRET_KEY
        ? { ok: true, status: 'configured', detail: 'CLERK_SECRET_KEY set — session-token verification active' }
        : { ok: false, status: 'not configured', detail: 'CLERK_SECRET_KEY missing — falling back to email-header gate (less secure)' };

      // Stripe — added v72w. Checks both that the secret is set AND that Stripe
      // accepts it (real network call). Reports mode (test vs live) and account
      // ID so the admin can confirm they're pointing at the right account.
      // Webhook secret is reported separately since it can be unset for a while
      // (only needed when we wire the checkout flow in v72z).
      if (!env.STRIPE_SECRET_KEY) {
        checks.stripe = {
          ok: false,
          status: 'not configured',
          detail: 'STRIPE_SECRET_KEY missing — add as encrypted env var in Cloudflare Pages settings'
        };
      } else {
        const stripe = getStripe(env);
        try {
          const account = await stripe.accounts.retrieve();
          const isTest = env.STRIPE_SECRET_KEY.startsWith('sk_test_');
          const webhookPart = env.STRIPE_WEBHOOK_SECRET
            ? ', webhook secret set'
            : ', webhook secret NOT set (needed before v72z)';
          checks.stripe = {
            ok: true,
            status: isTest ? 'test mode' : 'live mode',
            detail: `Connected to account ${account.id} (${account.country || '??'})` + webhookPart
          };
        } catch(e) {
          checks.stripe = {
            ok: false,
            status: 'auth error',
            detail: 'Stripe rejected the key: ' + String(e && e.message || e)
          };
        }
      }

      // Cron schedule + last run
      let lastRun = null;
      try {
        const raw = await env.DOSSIERS.get('__cron:last_run');
        if (raw) lastRun = JSON.parse(raw);
      } catch(_) {}
      let cronDetail;
      if (!lastRun) {
        cronDetail = 'Stale-conversation cron has not yet run (or last run pre-dates v72f). Configured: hourly (0 * * * *).';
      } else if (lastRun.skipped) {
        cronDetail = `Last ran ${new Date(lastRun.ranAt).toLocaleString()} but was skipped: ${lastRun.skipped}`;
      } else {
        cronDetail = `Scanned ${lastRun.scanned} convs, sent ${lastRun.sent} reminders in ${lastRun.durationMs}ms` + (lastRun.error ? ` — error: ${lastRun.error}` : '');
      }
      checks.cron = {
        ok: !!lastRun && !lastRun.skipped && !lastRun.error,
        status: lastRun ? (lastRun.skipped ? 'skipped' : (lastRun.error ? 'errored' : 'last ran ' + new Date(lastRun.ranAt).toLocaleString())) : 'no runs recorded',
        detail: cronDetail,
        schedule: '0 * * * * (hourly)',
        lastRun: lastRun
      };

      return jsonResponse({ ok: true, checks, generatedAt: new Date().toISOString() });
    }

    // ── /api/cron/run ─────────────────────────────────────────────
    // Admin-gated. Triggers the stale-conversation cron synchronously and returns
    // the result. Useful for: (a) confirming cron code works without waiting for
    // the next scheduled tick, (b) catching up on escalations after a deploy.
    // Also writes __cron:last_run, so the health card flips green after a run.
    if (url.pathname === '/api/cron/run') {
      if (!(await isAdmin())) return adminDenied();
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      await runStaleConvReminders(env);
      // Read back what was just written so the response includes the run summary
      let lastRun = null;
      try {
        const raw = await env.DOSSIERS.get('__cron:last_run');
        if (raw) lastRun = JSON.parse(raw);
      } catch(_) {}
      return jsonResponse({ ok: true, lastRun });
    }

    // ─────────────────────────────────────────────────────────────
    // ── Offers (v72y) ────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────
    // An offer is the partner's structured proposal for an enquiry — dates,
    // room, total price, inclusions, terms, validity. The deposit (= total
    // × commission_pct / 100) is collected by TheBearing if the member
    // accepts; the rest is settled directly between member and partner.
    //
    // KV schema:
    //   offer:{id}                 — full offer JSON record
    //   __offers_by_booking:{ref}  — array of offer IDs belonging to one booking
    //
    // Each booking record carries `offers: [ids]` and `active_offer_id`
    // (the most recently-sent, not-yet-superseded offer). The "active" offer
    // is what the member sees on /bookings/{ref}.
    //
    // Lifecycle states:
    //   draft     — partner is editing, not yet sent. Not visible to member.
    //   sent      — partner has sent. Visible to member. Awaits response.
    //   accepted  — member accepted. Stripe Checkout triggered (v72z).
    //   declined  — member declined. Conversation can continue, partner can
    //               build a fresh offer.
    //   changes_requested — member requested adjustments. Partner builds a
    //               revised offer (which supersedes this one).
    //   superseded — replaced by a newer offer. Frozen for audit history.
    //   expired   — valid_until passed without response. Cron job (future)
    //               will flip these automatically; for v72y, expiry is
    //               checked client-side on render.
    //   withdrawn — partner cancelled before member responded.
    //
    // Authorization for v72y:
    //   GET (by id or booking)     — public for now; member's /bookings
    //                                page reads via this endpoint
    //   POST/PATCH                 — NOT YET AUTHENTICATED. Partner portal
    //                                lacks a real auth layer (hardcoded
    //                                PP_SLUG). Real partner auth is on the
    //                                deferred work list. In test mode this
    //                                is acceptable; before going live we
    //                                MUST add partner authentication.
    if (url.pathname === '/api/offer') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      // v73j: shared helper — when an offer transitions into 'sent', post
      // a special offer_card message into the conversation linked to its
      // booking. The customer conversation renderer detects the
      // `type:'offer_card'` field and renders a styled card with a
      // "View offer" CTA instead of a plain text bubble.
      // Idempotent against the conversation: each call appends one new
      // message regardless of whether prior cards exist for the same offer
      // — caller is responsible for not double-firing (we only call from
      // the create-with-sendImmediately path and the PATCH action:'send').
      async function postOfferCardToConversation(offer) {
        try {
          // Find linked conversation via booking.conversationId
          const brRaw = await env.DOSSIERS.get('booking:' + offer.bookingId);
          if (!brRaw) return;
          const bk = JSON.parse(brRaw);
          const convId = bk.conversationId;
          if (!convId) return; // legacy bookings without a conv link
          const convRaw = await env.DOSSIERS.get('conversation:' + convId);
          if (!convRaw) return;
          const conv = JSON.parse(convRaw);
          const msgsRaw = await env.DOSSIERS.get('conversation:' + convId + ':messages');
          const messages = msgsRaw ? JSON.parse(msgsRaw) : [];
          const cardTs = new Date().toISOString();
          const card = {
            id: 'msg_' + Date.now() + '_card',
            role: 'partner',
            type: 'offer_card',
            // Compact summary for the card rendering — full offer fetched on click
            offerId: offer.id,
            offerSummary: {
              propertyName: offer.propertyName || '',
              arrival: offer.arrival || '',
              departure: offer.departure || '',
              nights: offer.nights || 0,
              guests: offer.guests || 0,
              room: offer.room || '',
              total_amount: offer.total_amount || 0,
              deposit_amount: offer.deposit_amount || 0,
              currency: offer.currency || 'USD',
              valid_until: offer.valid_until || null
            },
            // Plain-text fallback so renderers that don't know about
            // offer_card (older clients, email digests) still show something.
            text: 'Your offer is ready — ' + (offer.propertyName || 'the property') + ' has prepared a personalised quote. Open your conversation to view it.',
            senderName: offer.propertyName || 'Property',
            sentAt: cardTs,
            readAt: null
          };
          messages.push(card);

          // v73af: backfill conv.enquiry from the offer when the customer
          // didn't originally specify dates/room/guests. The customer's
          // conv list shows enquiry dates as a disambiguation subline; if
          // the original enquiry was open-ended, those fields are empty and
          // the subline doesn't render. Once the partner sends an offer with
          // dates, the conversation now has those facts \u2014 reflect them.
          // Only fills fields that are currently empty (never overwrites a
          // customer-supplied value).
          conv.enquiry = conv.enquiry || {};
          if (!conv.enquiry.arrival   && offer.arrival)   conv.enquiry.arrival   = offer.arrival;
          if (!conv.enquiry.departure && offer.departure) conv.enquiry.departure = offer.departure;
          if (!conv.enquiry.guests    && offer.guests)    conv.enquiry.guests    = offer.guests;
          if (!conv.enquiry.cabin     && offer.room)      conv.enquiry.cabin     = offer.room;

          conv.lastMessageAt = cardTs;
          conv.lastMessagePreview = '\ud83d\udccb Offer ready \u00b7 ' + (offer.propertyName || 'Property');
          conv.unreadGuest = (conv.unreadGuest || 0) + 1;
          await env.DOSSIERS.put('conversation:' + convId, JSON.stringify(conv));
          await env.DOSSIERS.put('conversation:' + convId + ':messages', JSON.stringify(messages));
          // Bump unread counters
          if (typeof recomputeUnreadCounters === 'function') {
            await recomputeUnreadCounters(env);
          }
          console.log('[Offer card] posted into conv ' + convId + ' for offer ' + offer.id);
        } catch (e) {
          console.error('[Offer card] failed:', e && e.stack || e);
          // Non-fatal — offer is already saved
        }
      }

      // ─ GET ─
      // ?id=X           → single offer
      // ?bookingId=X    → all offers for a booking, oldest first
      if (request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (id) {
          const raw = await env.DOSSIERS.get('offer:' + id);
          if (!raw) return jsonResponse({ id, data: null, exists: false });
          return jsonResponse({ id, data: JSON.parse(raw), exists: true });
        }
        const bookingId = url.searchParams.get('bookingId');
        if (!bookingId) {
          return jsonResponse({ error: 'id or bookingId required' }, 400);
        }
        const idxRaw = await env.DOSSIERS.get('__offers_by_booking:' + bookingId);
        const ids = idxRaw ? JSON.parse(idxRaw) : [];
        const offers = await Promise.all(ids.map(async (oid) => {
          const raw = await env.DOSSIERS.get('offer:' + oid);
          return raw ? JSON.parse(raw) : null;
        }));
        return jsonResponse({ bookingId, offers: offers.filter(Boolean) });
      }

      // ─ POST ─
      // Create a new offer. Body required:
      //   { bookingId, propertySlug, [trip fields], total_amount, ... }
      // Computes deposit from property's commission_pct (rejects if commission
      // not set — that's where v72x's null becomes truly required). Auto-
      // generates ID, sets status to "draft" unless `sendImmediately:true`.
      // Updates booking record's `offers` array. If `sendImmediately`, also
      // sets booking.active_offer_id.
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); }
        catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }

        const required = ['bookingId', 'propertySlug', 'total_amount'];
        for (const k of required) {
          if (body[k] === undefined || body[k] === null || body[k] === '') {
            return jsonResponse({ error: 'missing field: ' + k }, 400);
          }
        }
        const total = Number(body.total_amount);
        if (!isFinite(total) || total <= 0) {
          return jsonResponse({ error: 'total_amount must be a positive number' }, 400);
        }
        // Look up the property to grab the commission rate. Snapshot the rate
        // into the offer so future changes to the property don't retroactively
        // alter existing offers.
        const propRaw = await env.DOSSIERS.get(body.propertySlug + ':property');
        if (!propRaw) {
          return jsonResponse({ error: 'property not found: ' + body.propertySlug }, 404);
        }
        let prop;
        try { prop = JSON.parse(propRaw); }
        catch (e) { return jsonResponse({ error: 'property record corrupt' }, 500); }
        const commissionPct = (typeof prop.commission_pct === 'number') ? prop.commission_pct : null;
        if (commissionPct === null) {
          return jsonResponse({
            error: 'Cannot create offer: property ' + body.propertySlug +
                   ' has no commission_pct set. Set it in admin-property-editor first.'
          }, 400);
        }
        // Verify booking exists. We don't enforce booking ownership here
        // (no real partner auth yet), just integrity.
        const bookingRaw = await env.DOSSIERS.get('booking:' + body.bookingId);
        if (!bookingRaw) {
          return jsonResponse({ error: 'booking not found: ' + body.bookingId }, 404);
        }
        const booking = JSON.parse(bookingRaw);
        if (!Array.isArray(booking.offers)) booking.offers = [];

        // Generate offer ID. Format mirrors booking ref for consistency.
        const year = new Date().getFullYear();
        const rand = Math.floor(10000 + Math.random() * 90000);
        const offerId = 'OFR-' + year + '-' + rand;
        const now = new Date().toISOString();

        // Compute deposit. Keep 2-decimal precision to avoid float weirdness.
        const depositAmount = Math.round(total * commissionPct) / 100;

        // Default validity: 7 days from now if not specified.
        let validUntil = body.valid_until;
        if (!validUntil) {
          validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        }

        const inclusions = Array.isArray(body.inclusions)
          ? body.inclusions.filter(function(x) { return typeof x === 'string' && x.trim().length > 0; }).map(function(x) { return x.trim(); })
          : [];

        const sendImmediately = body.sendImmediately === true;

        const offer = {
          id: offerId,
          bookingId: body.bookingId,
          propertySlug: body.propertySlug,
          propertyName: body.propertyName || prop.name || '',
          // Trip details
          arrival: body.arrival || '',
          departure: body.departure || '',
          nights: body.nights || 0,
          guests: body.guests || 0,
          room: body.room || '',
          // v73y: snapshot of the original enquiry's cabin so customer-side
          // offer card can flag when the property is offering a different
          // room. Falls back to booking.room if enquiry_snapshot was not
          // captured (older bookings created pre-v73y).
          enquiry_cabin: (booking.enquiry_snapshot && booking.enquiry_snapshot.cabin) || booking.room || '',
          // v73aa: balance-due date for the remaining (non-deposit) amount.
          // Partner sets in the offer builder. Surfaced on customer's
          // confirmed-booking detail view. Optional — empty string means
          // "balance due upon arrival" (default for cruises/all-inclusives).
          balance_due_date: typeof body.balance_due_date === 'string' ? body.balance_due_date.trim() : '',
          // Pricing
          pricing_mode: body.pricing_mode === 'per_night' ? 'per_night' : 'package',
          nightly_rate: Number(body.nightly_rate) || 0,
          total_amount: total,
          currency: 'USD',
          commission_pct_at_time: commissionPct,
          deposit_amount: depositAmount,
          // Structured content
          inclusions: inclusions,
          exclusions: typeof body.exclusions === 'string' ? body.exclusions.trim() : '',
          cancellation_terms: typeof body.cancellation_terms === 'string' ? body.cancellation_terms.trim() : '',
          partner_notes: typeof body.partner_notes === 'string' ? body.partner_notes.trim() : '',
          // Lifecycle
          status: sendImmediately ? 'sent' : 'draft',
          valid_until: validUntil,
          created_at: now,
          sent_at: sendImmediately ? now : null,
          responded_at: null,
          supersedes: body.supersedes || null,
          superseded_by: null,
        };

        // If this offer supersedes a previous one, flip the previous to
        // "superseded" status and link both directions.
        if (offer.supersedes) {
          const prevRaw = await env.DOSSIERS.get('offer:' + offer.supersedes);
          if (prevRaw) {
            const prev = JSON.parse(prevRaw);
            prev.status = 'superseded';
            prev.superseded_by = offerId;
            await env.DOSSIERS.put('offer:' + prev.id, JSON.stringify(prev));
          }
        }

        // Write the offer
        await env.DOSSIERS.put('offer:' + offerId, JSON.stringify(offer));

        // Append to per-booking offers index
        const offerIdxKey = '__offers_by_booking:' + body.bookingId;
        const idxRaw = await env.DOSSIERS.get(offerIdxKey);
        const ids = idxRaw ? JSON.parse(idxRaw) : [];
        ids.push(offerId);
        await env.DOSSIERS.put(offerIdxKey, JSON.stringify(ids));

        // Update booking record
        booking.offers = (booking.offers || []).concat([offerId]);
        if (sendImmediately) {
          booking.active_offer_id = offerId;
          booking.status = 'offer_sent';
        } else if (!booking.active_offer_id && booking.status === 'pending') {
          // Stays pending — draft doesn't change booking-level state
        }
        booking.updatedAt = now;
        await env.DOSSIERS.put('booking:' + body.bookingId, JSON.stringify(booking));

        // v73j: if this offer was sent immediately, post an offer_card
        // message into the linked conversation so the guest sees it
        // alongside their enquiry thread.
        if (sendImmediately) {
          await postOfferCardToConversation(offer);
        }

        return jsonResponse({ ok: true, offer });
      }

      // ─ PATCH ─
      // Update an offer. Body required: { id, ...fields }
      // Allowed transitions (state machine):
      //   draft → sent (via action:'send')
      //   draft → withdrawn (via action:'withdraw')
      //   sent  → withdrawn (via action:'withdraw') — partner pulls offer back
      // Field edits are only allowed when status === 'draft'.
      // accepted/declined/changes_requested transitions are member-driven
      // and come in v72z; for now PATCH only handles partner-side state.
      if (request.method === 'PATCH') {
        let body;
        try { body = await request.json(); }
        catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
        if (!body.id) return jsonResponse({ error: 'id required' }, 400);

        const raw = await env.DOSSIERS.get('offer:' + body.id);
        if (!raw) return jsonResponse({ error: 'offer not found' }, 404);
        const offer = JSON.parse(raw);

        const now = new Date().toISOString();

        if (body.action === 'send') {
          if (offer.status !== 'draft') {
            return jsonResponse({ error: 'can only send from draft, current: ' + offer.status }, 400);
          }
          offer.status = 'sent';
          offer.sent_at = now;
          // Update booking
          const brRaw = await env.DOSSIERS.get('booking:' + offer.bookingId);
          if (brRaw) {
            const booking = JSON.parse(brRaw);
            booking.active_offer_id = offer.id;
            booking.status = 'offer_sent';
            booking.updatedAt = now;
            await env.DOSSIERS.put('booking:' + offer.bookingId, JSON.stringify(booking));
          }
          // v73j: post offer_card message into linked conversation
          await postOfferCardToConversation(offer);
        } else if (body.action === 'withdraw') {
          if (offer.status !== 'draft' && offer.status !== 'sent') {
            return jsonResponse({ error: 'can only withdraw from draft or sent' }, 400);
          }
          offer.status = 'withdrawn';
          offer.responded_at = now;
          // Clear booking.active_offer_id if it was this one
          const brRaw = await env.DOSSIERS.get('booking:' + offer.bookingId);
          if (brRaw) {
            const booking = JSON.parse(brRaw);
            if (booking.active_offer_id === offer.id) {
              booking.active_offer_id = null;
              booking.status = 'pending';
            }
            booking.updatedAt = now;
            await env.DOSSIERS.put('booking:' + offer.bookingId, JSON.stringify(booking));
          }
        } else if (body.action === 'decline') {
          // v73r: customer-initiated decline. Requires requesterEmail to match
          // the booking's guest email. Reopens the booking to 'enquiry' so the
          // partner can build a fresh offer (or the customer can re-enquire
          // cleanly). Posts a system message into the conversation so the
          // partner sees the decline reason if provided.
          if (offer.status !== 'sent') {
            return jsonResponse({ error: 'can only decline a sent offer (current: ' + offer.status + ')' }, 400);
          }
          const reqEmail = (body.requesterEmail || '').toLowerCase().trim();
          const brRawDecline = await env.DOSSIERS.get('booking:' + offer.bookingId);
          if (!brRawDecline) return jsonResponse({ error: 'booking not found' }, 404);
          const bookingDecline = JSON.parse(brRawDecline);
          const bookingEmailDecline = (bookingDecline.email || '').toLowerCase().trim();
          const isAdminCaller = await isAdmin();
          if (!isAdminCaller && (!reqEmail || reqEmail !== bookingEmailDecline)) {
            return jsonResponse({ error: 'not authorised to decline this offer' }, 403);
          }

          offer.status = 'declined';
          offer.responded_at = now;
          offer.declined_reason = (body.reason || '').slice(0, 500);

          if (bookingDecline.active_offer_id === offer.id) {
            bookingDecline.active_offer_id = null;
            // Reset back to 'enquiry' so partner sees a "Build offer" button
            // again.
            bookingDecline.status = 'enquiry';

            // v73u: if there's a pendingChangeRequest, copy it onto the
            // booking shape so the partner sees a fresh enquiry with the
            // customer's most recent ask already populated. The customer's
            // most recent request is what they actually want; the offer's
            // dates were the partner's prior proposal, which the customer
            // just rejected. After copying, clear pendingChangeRequest so
            // the new state is a normal enquiry, not a flagged one.
            const pcr = bookingDecline.pendingChangeRequest;
            if (pcr) {
              if (pcr.arrival)   bookingDecline.arrival   = pcr.arrival;
              if (pcr.departure) bookingDecline.departure = pcr.departure;
              if (pcr.guests)    bookingDecline.guests    = pcr.guests;
              if (pcr.cabin)     bookingDecline.room      = pcr.cabin;
              if (pcr.notes)     bookingDecline.notes     = pcr.notes;
              delete bookingDecline.pendingChangeRequest;
            }
            // If no change request existed, leave the booking dates at the
            // offer's frozen dates (better than empty, partner can revise).

            // Flag the booking as previously-declined so partner sees a
            // sand-colored row treatment + "Previously declined offer" pill
            // rather than the row looking like a brand-new enquiry.
            bookingDecline.declinedAt = now;
            bookingDecline.lastDeclinedOfferId = offer.id;
          }
          bookingDecline.updatedAt = now;
          await env.DOSSIERS.put('booking:' + offer.bookingId, JSON.stringify(bookingDecline));

          // Post system message into linked conversation so partner sees it
          if (bookingDecline.conversationId) {
            try {
              const convDeclineRaw = await env.DOSSIERS.get('conversation:' + bookingDecline.conversationId);
              if (convDeclineRaw) {
                const convDecline = JSON.parse(convDeclineRaw);
                const msgsDeclineRaw = await env.DOSSIERS.get('conversation:' + bookingDecline.conversationId + ':messages');
                const messagesDecline = msgsDeclineRaw ? JSON.parse(msgsDeclineRaw) : [];
                const declineMsg = {
                  id: 'msg_' + Date.now() + '_decl',
                  role: 'system',
                  type: 'offer_declined',
                  text: 'Guest declined the offer.' + (offer.declined_reason ? ' Reason: ' + offer.declined_reason : '') + ' The booking is open for a fresh offer.',
                  senderName: 'The Bearing',
                  sentAt: now,
                  readAt: null,
                  offerId: offer.id,
                };
                messagesDecline.push(declineMsg);
                convDecline.lastMessageAt = now;
                convDecline.lastMessagePreview = 'Offer declined by guest';
                convDecline.unreadAdmin = (convDecline.unreadAdmin || 0) + 1; // bump admin/partner attention
                await env.DOSSIERS.put('conversation:' + bookingDecline.conversationId, JSON.stringify(convDecline));
                await env.DOSSIERS.put('conversation:' + bookingDecline.conversationId + ':messages', JSON.stringify(messagesDecline));
              }
            } catch (e) {
              console.error('[Offer decline] system message post failed:', e);
            }
          }

          // Notify admin + partner via Resend (best-effort)
          if (env.RESEND_API_KEY) {
            try {
              const adminRecipients = await loadNotificationRecipients(env);
              if (adminRecipients.length) {
                await fetch('https://api.resend.com/emails', {
                  method: 'POST',
                  headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    from: 'The Bearing <bookings@thebearing.io>',
                    to: adminRecipients,
                    subject: '[DECLINED] ' + (bookingDecline.property || bookingDecline.slug) + ' · ' + bookingDecline.ref,
                    html: '<div style="font-family:Geist,system-ui,sans-serif;padding:24px;">'
                      + '<h2 style="font-family:\'Instrument Serif\',Georgia,serif;font-weight:400;margin:0 0 12px;">Offer declined</h2>'
                      + '<p><strong>' + (bookingDecline.property || bookingDecline.slug) + '</strong></p>'
                      + '<p>Guest: ' + (bookingDecline.email || 'unknown') + '</p>'
                      + '<p>Reference: <code>' + bookingDecline.ref + '</code></p>'
                      + (offer.declined_reason ? '<p>Reason: ' + offer.declined_reason + '</p>' : '')
                      + '<p>The booking is now back to <code>enquiry</code> — partner can build a fresh offer.</p>'
                      + '</div>',
                  }),
                }).catch(function(e) { console.error('[Offer decline] admin email failed:', e); });
              }
            } catch (e) { console.error('[Offer decline] email block failed:', e); }
          }
        } else if (body.action === 'edit-draft') {
          if (offer.status !== 'draft') {
            return jsonResponse({ error: 'can only edit drafts, current: ' + offer.status }, 400);
          }
          // Apply field updates. Re-validate critical fields.
          const editable = ['arrival', 'departure', 'nights', 'guests', 'room',
                            'pricing_mode', 'nightly_rate', 'total_amount',
                            'inclusions', 'exclusions', 'cancellation_terms',
                            'partner_notes', 'valid_until'];
          for (const k of editable) {
            if (body[k] !== undefined) offer[k] = body[k];
          }
          // Recompute deposit if total or commission changed (commission can't
          // change post-create — it's frozen at the snapshotted rate).
          if (typeof offer.total_amount === 'number' && typeof offer.commission_pct_at_time === 'number') {
            offer.deposit_amount = Math.round(offer.total_amount * offer.commission_pct_at_time) / 100;
          }
          // Sanitize inclusions
          if (Array.isArray(offer.inclusions)) {
            offer.inclusions = offer.inclusions
              .filter(function(x) { return typeof x === 'string' && x.trim().length > 0; })
              .map(function(x) { return x.trim(); });
          }
        } else {
          return jsonResponse({ error: 'unknown action: ' + body.action }, 400);
        }

        await env.DOSSIERS.put('offer:' + offer.id, JSON.stringify(offer));
        return jsonResponse({ ok: true, offer });
      }

      return new Response('Method not allowed', { status: 405 });
    }

    // ── /api/checkout/create-session ──────────────────────────────
    // v73q: Customer-initiated Stripe Checkout for offer acceptance.
    // POST body: { offerId, requesterEmail }
    //   offerId — the offer the customer is accepting
    //   requesterEmail — Clerk-supplied email of the customer, used to
    //                    verify ownership against booking.email
    // Returns: { url } — Stripe-hosted checkout URL for the frontend to
    //          redirect to. Or { error } on validation failure.
    //
    // Why email-based auth (not Clerk session): the cancel-enquiry endpoint
    // (v73m) established the requesterEmail pattern. Worst case if a third
    // party knows the booking + email: they could PAY for someone else's
    // booking. Financial harm accrues to the attacker, not the victim.
    // Real fix is Clerk session verification, deferred.
    // ── /api/checkout/create-intent ────────────────────────────────
    // v73ab: inline Stripe Payment Element flow. Creates a PaymentIntent
    // and returns its client_secret so the frontend can embed Stripe's
    // Payment Element on the page instead of redirecting to Stripe-hosted
    // checkout. Mirrors create-session's auth + validation; differs only
    // in what it returns.
    //
    // POST body: { offerId, requesterEmail }
    // Returns: { client_secret, publishable_key, payment_intent_id, amount, currency }
    //          or { error }.
    //
    // The webhook handler is the source of truth — it processes
    // payment_intent.succeeded the same way it processes
    // checkout.session.completed, so booking confirmation flow is shared.
    if (url.pathname === '/api/checkout/create-intent') {
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      const stripe = getStripe(env);
      if (!stripe) return jsonResponse({ error: 'Stripe not configured' }, 503);
      if (!env.STRIPE_PUBLISHABLE_KEY) {
        console.error('[Checkout/intent] STRIPE_PUBLISHABLE_KEY not set');
        return jsonResponse({ error: 'Stripe publishable key not configured' }, 503);
      }

      let body;
      try { body = await request.json(); }
      catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
      const { offerId, requesterEmail } = body;
      if (!offerId) return jsonResponse({ error: 'offerId required' }, 400);
      if (!requesterEmail) return jsonResponse({ error: 'requesterEmail required' }, 400);

      const offerRaw = await env.DOSSIERS.get('offer:' + offerId);
      if (!offerRaw) return jsonResponse({ error: 'offer not found' }, 404);
      const offer = JSON.parse(offerRaw);

      if (offer.status !== 'sent') {
        return jsonResponse({ error: 'offer is not in a payable state (status: ' + offer.status + ')' }, 400);
      }
      if (offer.valid_until) {
        const expired = new Date(offer.valid_until).getTime() < Date.now();
        if (expired) return jsonResponse({ error: 'offer has expired' }, 400);
      }
      const depositCents = Math.round(Number(offer.deposit_amount || 0) * 100);
      if (!depositCents || depositCents < 50) {
        return jsonResponse({ error: 'invalid deposit amount' }, 400);
      }

      const bookingRaw = await env.DOSSIERS.get('booking:' + offer.bookingId);
      if (!bookingRaw) return jsonResponse({ error: 'booking not found' }, 404);
      const booking = JSON.parse(bookingRaw);
      const bookingEmail = (booking.email || '').toLowerCase().trim();
      const reqEmail = (requesterEmail || '').toLowerCase().trim();
      if (!bookingEmail || bookingEmail !== reqEmail) {
        return jsonResponse({ error: 'not authorised for this offer' }, 403);
      }
      if (booking.status === 'confirmed' || booking.paymentStatus === 'deposit_paid') {
        return jsonResponse({ error: 'booking is already confirmed' }, 400);
      }

      const productName = (offer.propertyName || 'TheBearing booking') + ' \u2014 deposit';
      let productDescription = '';
      if (offer.arrival && offer.departure) {
        productDescription = offer.arrival + ' \u2192 ' + offer.departure;
        if (offer.nights) productDescription += ' \u00b7 ' + offer.nights + ' night' + (offer.nights === 1 ? '' : 's');
      }
      if (offer.room) productDescription = (productDescription ? productDescription + ' \u00b7 ' : '') + offer.room;

      try {
        const intent = await stripe.paymentIntents.create({
          amount: depositCents,
          currency: (offer.currency || 'usd').toLowerCase(),
          // Automatic payment methods lets Stripe surface card / Apple Pay /
          // Google Pay / Link as appropriate for the customer. With the
          // Payment Element they all render in one component.
          automatic_payment_methods: { enabled: true },
          receipt_email: bookingEmail,
          description: productName + (productDescription ? ' (' + productDescription + ')' : ''),
          metadata: {
            offerId: offer.id,
            bookingRef: offer.bookingId,
            propertySlug: offer.propertySlug || '',
            conversationId: booking.conversationId || '',
            inlineFlow: 'true',
          },
          statement_descriptor_suffix: 'BEARING',
        });
        console.log('[Checkout/intent] created PI ' + intent.id + ' for offer ' + offer.id + ' (' + depositCents + ' cents)');
        return jsonResponse({
          client_secret: intent.client_secret,
          publishable_key: env.STRIPE_PUBLISHABLE_KEY,
          payment_intent_id: intent.id,
          amount: depositCents,
          currency: (offer.currency || 'usd').toLowerCase(),
        });
      } catch (err) {
        console.error('[Checkout/intent] Stripe error:', err && err.message);
        return jsonResponse({ error: 'PaymentIntent creation failed: ' + (err.message || 'unknown') }, 500);
      }
    }

    // ── /api/admin/sync-stripe-payment ────────────────────────────
    // v73af: admin-gated rescue endpoint. Same as /api/checkout/sync-payment
    // but bypasses the requesterEmail check (since admin won't necessarily
    // know the customer's email). For one-off manual repair of bookings
    // where the inline payment succeeded at Stripe but our records are
    // stuck. Paste the PaymentIntent ID from Stripe dashboard.
    if (url.pathname === '/api/admin/sync-stripe-payment') {
      if (!(await isAdmin())) return adminDenied();
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      const stripe = getStripe(env);
      if (!stripe) return jsonResponse({ error: 'Stripe not configured' }, 503);

      let body;
      try { body = await request.json(); }
      catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
      const { paymentIntentId } = body;
      if (!paymentIntentId) return jsonResponse({ error: 'paymentIntentId required' }, 400);

      let pi;
      try {
        pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      } catch (err) {
        return jsonResponse({ error: 'could not retrieve PI: ' + (err.message || 'unknown') }, 500);
      }
      if (!pi || pi.status !== 'succeeded') {
        return jsonResponse({ error: 'payment status: ' + (pi && pi.status || 'unknown'), status: pi && pi.status }, 400);
      }
      const meta = pi.metadata || {};
      const offerId = meta.offerId;
      const bookingRef = meta.bookingRef;
      if (!offerId || !bookingRef) {
        return jsonResponse({ error: 'PI missing offerId/bookingRef metadata' }, 400);
      }

      const bookingRaw = await env.DOSSIERS.get('booking:' + bookingRef);
      if (!bookingRaw) return jsonResponse({ error: 'booking not found: ' + bookingRef }, 404);
      const booking = JSON.parse(bookingRaw);

      // Idempotency
      if (booking.paymentStatus === 'deposit_paid' && booking.stripeSessionId === pi.id) {
        return jsonResponse({
          ok: true, status: 'already-processed',
          booking: { ref: bookingRef, status: booking.status, paymentStatus: booking.paymentStatus }
        });
      }

      const now = new Date().toISOString();
      const depositPaid = Number(pi.amount_received || pi.amount || 0) / 100;
      let acceptedOffer = null;
      try {
        const offerRaw = await env.DOSSIERS.get('offer:' + offerId);
        if (offerRaw) acceptedOffer = JSON.parse(offerRaw);
      } catch (e) {}

      booking.status = 'confirmed';
      booking.paymentStatus = 'deposit_paid';
      booking.stripeSessionId = pi.id;
      booking.stripePaymentIntent = pi.id;
      booking.depositPaidAmount = depositPaid;
      booking.depositPaidAt = now;
      booking.updatedAt = now;
      if (acceptedOffer) {
        booking.confirmed_total_amount = acceptedOffer.total_amount || 0;
        booking.confirmed_deposit_amount = acceptedOffer.deposit_amount || 0;
        booking.confirmed_balance_due_date = acceptedOffer.balance_due_date || '';
        booking.confirmed_inclusions = Array.isArray(acceptedOffer.inclusions) ? acceptedOffer.inclusions : [];
        booking.confirmed_exclusions = acceptedOffer.exclusions || '';
        booking.confirmed_cancellation_terms = acceptedOffer.cancellation_terms || '';
        booking.confirmed_partner_notes = acceptedOffer.partner_notes || '';
        booking.confirmed_offer_id = acceptedOffer.id;
        booking.confirmed_currency = acceptedOffer.currency || 'USD';
      }
      await env.DOSSIERS.put('booking:' + bookingRef, JSON.stringify(booking));

      if (acceptedOffer) {
        try {
          acceptedOffer.status = 'accepted';
          acceptedOffer.responded_at = now;
          acceptedOffer.stripeSessionId = pi.id;
          await env.DOSSIERS.put('offer:' + offerId, JSON.stringify(acceptedOffer));
        } catch (e) {}
      }

      // Conversation message
      const convId = booking.conversationId || meta.conversationId || null;
      if (convId) {
        try {
          const convRaw = await env.DOSSIERS.get('conversation:' + convId);
          if (convRaw) {
            const conv = JSON.parse(convRaw);
            const msgsRaw = await env.DOSSIERS.get('conversation:' + convId + ':messages');
            const messages = msgsRaw ? JSON.parse(msgsRaw) : [];
            // Don't duplicate if a booking_confirmed already exists for this booking
            const alreadyPosted = messages.some(function(m) {
              return m && m.type === 'booking_confirmed' && m.bookingRef === bookingRef;
            });
            if (!alreadyPosted) {
              messages.push({
                id: 'msg_' + Date.now() + '_paid',
                role: 'system',
                type: 'booking_confirmed',
                text: '\u2713 Deposit paid \u00b7 Booking confirmed \u00b7 ' + bookingRef + '\n\n$' + depositPaid.toLocaleString() + ' received. The property has been notified.',
                senderName: 'The Bearing',
                sentAt: now,
                readAt: null,
                bookingRef: bookingRef,
              });
              conv.lastMessageAt = now;
              conv.lastMessagePreview = '\u2713 Booking confirmed';
              conv.unreadAdmin = (conv.unreadAdmin || 0) + 1;
              await env.DOSSIERS.put('conversation:' + convId, JSON.stringify(conv));
              await env.DOSSIERS.put('conversation:' + convId + ':messages', JSON.stringify(messages));
              try { await recomputeUnreadCounters(env); } catch(_) {}
            }
          }
        } catch (e) {
          console.error('[Admin sync] conv message post failed:', e && e.message);
        }
      }

      return jsonResponse({
        ok: true,
        status: 'confirmed',
        booking: {
          ref: bookingRef,
          status: 'confirmed',
          paymentStatus: 'deposit_paid',
          depositPaidAmount: depositPaid,
        }
      });
    }

    // ── /api/checkout/sync-payment ────────────────────────────────
    // v73af: client-side safety net for the inline Stripe Payment Element
    // flow. After stripe.confirmPayment() succeeds client-side, the client
    // calls this endpoint with the PaymentIntent ID. We:
    //   1. Verify with Stripe that the PI is actually 'succeeded' (don't
    //      trust the client claim alone).
    //   2. Run the same booking-confirmation flow the webhook would run:
    //      mark booking confirmed, post system message, snapshot offer
    //      details onto booking.
    //   3. Skip emails here (the webhook will fire them; if the webhook
    //      isn't subscribed to payment_intent.succeeded, that's a known
    //      gap the operator must fix in Stripe dashboard).
    //
    // Idempotency: shares the same guard as the webhook
    // (booking.paymentStatus === 'deposit_paid' && booking.stripeSessionId === pi.id).
    // Multiple calls (client retry, webhook firing later) all no-op safely.
    //
    // Auth: requesterEmail must match booking.email (same pattern as
    // create-intent / cancel-enquiry / decline-offer).
    if (url.pathname === '/api/checkout/sync-payment') {
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      const stripe = getStripe(env);
      if (!stripe) return jsonResponse({ error: 'Stripe not configured' }, 503);

      let body;
      try { body = await request.json(); }
      catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
      const { paymentIntentId, requesterEmail } = body;
      if (!paymentIntentId) return jsonResponse({ error: 'paymentIntentId required' }, 400);
      if (!requesterEmail) return jsonResponse({ error: 'requesterEmail required' }, 400);

      // Step 1: verify with Stripe
      let pi;
      try {
        pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      } catch (err) {
        console.error('[Sync payment] Stripe retrieve failed:', err && err.message);
        return jsonResponse({ error: 'could not verify payment: ' + (err.message || 'unknown') }, 500);
      }
      if (!pi || pi.status !== 'succeeded') {
        return jsonResponse({ error: 'payment not succeeded (status: ' + (pi && pi.status || 'unknown') + ')', status: pi && pi.status }, 400);
      }
      const meta = pi.metadata || {};
      const offerId = meta.offerId;
      const bookingRef = meta.bookingRef;
      if (!offerId || !bookingRef) {
        console.error('[Sync payment] PI ' + pi.id + ' missing offerId/bookingRef metadata');
        return jsonResponse({ error: 'payment intent missing booking metadata' }, 400);
      }

      const bookingRaw = await env.DOSSIERS.get('booking:' + bookingRef);
      if (!bookingRaw) {
        console.error('[Sync payment] booking ' + bookingRef + ' not found');
        return jsonResponse({ error: 'booking not found' }, 404);
      }
      const booking = JSON.parse(bookingRaw);

      // Auth: requesterEmail must match booking.email
      const bookingEmail = (booking.email || '').toLowerCase().trim();
      const reqEmail = (requesterEmail || '').toLowerCase().trim();
      if (!bookingEmail || bookingEmail !== reqEmail) {
        return jsonResponse({ error: 'not authorised for this booking' }, 403);
      }

      // Idempotency: if already processed for this PI, return current state.
      if (booking.paymentStatus === 'deposit_paid' && booking.stripeSessionId === pi.id) {
        console.log('[Sync payment] booking ' + bookingRef + ' already processed for PI ' + pi.id);
        return jsonResponse({
          ok: true,
          status: 'already-processed',
          booking: { ref: bookingRef, status: booking.status, paymentStatus: booking.paymentStatus }
        });
      }

      const now = new Date().toISOString();
      const depositPaid = Number(pi.amount_received || pi.amount || 0) / 100;

      // Snapshot the accepted offer's details onto the booking (v73aa pattern)
      let acceptedOffer = null;
      try {
        const offerRaw = await env.DOSSIERS.get('offer:' + offerId);
        if (offerRaw) acceptedOffer = JSON.parse(offerRaw);
      } catch (e) {
        console.error('[Sync payment] offer read for snapshot failed:', e && e.message);
      }

      // Update booking
      booking.status = 'confirmed';
      booking.paymentStatus = 'deposit_paid';
      booking.stripeSessionId = pi.id; // use PI id as the "session" identifier for idempotency
      booking.stripePaymentIntent = pi.id;
      booking.depositPaidAmount = depositPaid;
      booking.depositPaidAt = now;
      booking.updatedAt = now;
      if (acceptedOffer) {
        booking.confirmed_total_amount = acceptedOffer.total_amount || 0;
        booking.confirmed_deposit_amount = acceptedOffer.deposit_amount || 0;
        booking.confirmed_balance_due_date = acceptedOffer.balance_due_date || '';
        booking.confirmed_inclusions = Array.isArray(acceptedOffer.inclusions) ? acceptedOffer.inclusions : [];
        booking.confirmed_exclusions = acceptedOffer.exclusions || '';
        booking.confirmed_cancellation_terms = acceptedOffer.cancellation_terms || '';
        booking.confirmed_partner_notes = acceptedOffer.partner_notes || '';
        booking.confirmed_offer_id = acceptedOffer.id;
        booking.confirmed_currency = acceptedOffer.currency || 'USD';
      }
      await env.DOSSIERS.put('booking:' + bookingRef, JSON.stringify(booking));

      // Mark offer accepted
      try {
        if (acceptedOffer) {
          acceptedOffer.status = 'accepted';
          acceptedOffer.responded_at = now;
          acceptedOffer.stripeSessionId = pi.id;
          await env.DOSSIERS.put('offer:' + offerId, JSON.stringify(acceptedOffer));
        }
      } catch (e) {
        console.error('[Sync payment] offer update failed:', e && e.message);
      }

      // Post system message into conversation
      const convId = booking.conversationId || meta.conversationId || null;
      if (convId) {
        try {
          const convRaw = await env.DOSSIERS.get('conversation:' + convId);
          if (convRaw) {
            const conv = JSON.parse(convRaw);
            const msgsRaw = await env.DOSSIERS.get('conversation:' + convId + ':messages');
            const messages = msgsRaw ? JSON.parse(msgsRaw) : [];
            const sysMsg = {
              id: 'msg_' + Date.now() + '_paid',
              role: 'system',
              type: 'booking_confirmed',
              text: '\u2713 Deposit paid \u00b7 Booking confirmed \u00b7 ' + bookingRef + '\n\n$' + depositPaid.toLocaleString() + ' received. The property has been notified.',
              senderName: 'The Bearing',
              sentAt: now,
              readAt: null,
              bookingRef: bookingRef,
            };
            messages.push(sysMsg);
            conv.lastMessageAt = now;
            conv.lastMessagePreview = '\u2713 Booking confirmed';
            conv.unreadAdmin = (conv.unreadAdmin || 0) + 1;
            await env.DOSSIERS.put('conversation:' + convId, JSON.stringify(conv));
            await env.DOSSIERS.put('conversation:' + convId + ':messages', JSON.stringify(messages));
            try { await recomputeUnreadCounters(env); } catch(_) {}
            console.log('[Sync payment] posted booking_confirmed system message to conversation ' + convId);
          }
        } catch (e) {
          console.error('[Sync payment] conversation message post failed:', e && e.message);
        }
      } else {
        console.warn('[Sync payment] booking ' + bookingRef + ' has no conversationId \u2014 system message NOT posted');
      }

      console.log('[Sync payment] booking ' + bookingRef + ' confirmed via client sync for PI ' + pi.id);
      return jsonResponse({
        ok: true,
        status: 'confirmed',
        booking: {
          ref: bookingRef,
          status: 'confirmed',
          paymentStatus: 'deposit_paid',
          depositPaidAmount: depositPaid,
        }
      });
    }

    // ── /api/checkout/create-session ───────────────────────────────
    if (url.pathname === '/api/checkout/create-session') {
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      const stripe = getStripe(env);
      if (!stripe) return jsonResponse({ error: 'Stripe not configured' }, 503);

      let body;
      try { body = await request.json(); }
      catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
      const { offerId, requesterEmail } = body;
      if (!offerId) return jsonResponse({ error: 'offerId required' }, 400);
      if (!requesterEmail) return jsonResponse({ error: 'requesterEmail required' }, 400);

      const offerRaw = await env.DOSSIERS.get('offer:' + offerId);
      if (!offerRaw) return jsonResponse({ error: 'offer not found' }, 404);
      const offer = JSON.parse(offerRaw);

      if (offer.status !== 'sent') {
        return jsonResponse({ error: 'offer is not in a payable state (status: ' + offer.status + ')' }, 400);
      }
      if (offer.valid_until) {
        const expired = new Date(offer.valid_until).getTime() < Date.now();
        if (expired) return jsonResponse({ error: 'offer has expired' }, 400);
      }
      const depositCents = Math.round(Number(offer.deposit_amount || 0) * 100);
      if (!depositCents || depositCents < 50) {
        // Stripe minimum charge is $0.50 USD
        return jsonResponse({ error: 'invalid deposit amount' }, 400);
      }

      const bookingRaw = await env.DOSSIERS.get('booking:' + offer.bookingId);
      if (!bookingRaw) return jsonResponse({ error: 'booking not found' }, 404);
      const booking = JSON.parse(bookingRaw);
      const bookingEmail = (booking.email || '').toLowerCase().trim();
      const reqEmail = (requesterEmail || '').toLowerCase().trim();
      if (!bookingEmail || bookingEmail !== reqEmail) {
        return jsonResponse({ error: 'not authorised for this offer' }, 403);
      }
      if (booking.status === 'confirmed' || booking.paymentStatus === 'deposit_paid') {
        return jsonResponse({ error: 'booking is already confirmed' }, 400);
      }

      const origin = url.origin;
      const productName = (offer.propertyName || 'TheBearing booking') + ' — deposit';
      let productDescription = '';
      if (offer.arrival && offer.departure) {
        productDescription = offer.arrival + ' → ' + offer.departure;
        if (offer.nights) productDescription += ' · ' + offer.nights + ' night' + (offer.nights === 1 ? '' : 's');
      }
      if (offer.room) productDescription = (productDescription ? productDescription + ' · ' : '') + offer.room;

      try {
        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          payment_method_types: ['card'],
          customer_email: bookingEmail,
          line_items: [{
            quantity: 1,
            price_data: {
              currency: (offer.currency || 'usd').toLowerCase(),
              unit_amount: depositCents,
              product_data: {
                name: productName,
                description: productDescription || undefined,
              },
            },
          }],
          // Metadata is what the webhook reads to identify which offer/booking
          // this payment is for. Stored on session + payment intent.
          metadata: {
            offerId: offer.id,
            bookingRef: offer.bookingId,
            propertySlug: offer.propertySlug || '',
            conversationId: booking.conversationId || '',
          },
          payment_intent_data: {
            metadata: {
              offerId: offer.id,
              bookingRef: offer.bookingId,
            },
            statement_descriptor_suffix: 'BEARING',
          },
          success_url: origin + '/bookings.html?checkout=success&session_id={CHECKOUT_SESSION_ID}',
          cancel_url: origin + '/bookings.html?checkout=cancelled',
          expires_at: Math.floor(Date.now() / 1000) + (30 * 60),
        });
        console.log('[Checkout] created session ' + session.id + ' for offer ' + offer.id + ' (deposit ' + depositCents + ' cents)');
        return jsonResponse({ url: session.url, sessionId: session.id });
      } catch (err) {
        console.error('[Checkout] Stripe error:', err && err.message);
        return jsonResponse({ error: 'checkout creation failed: ' + (err.message || 'unknown') }, 500);
      }
    }

    // ── Stripe health check (admin-gated) ─────────────────────────
    // Returns whether STRIPE_SECRET_KEY is set AND Stripe accepts it. The
    // admin-settings System Health card calls this; admin-payments uses it
    // to decide which status banner to show.
    //
    // Response shape:
    //   { configured: false }                              — no env var set
    //   { configured: true, ok: false, error: '...' }      — key set but rejected
    //   { configured: true, ok: true, mode: 'test'|'live',
    //     account_id: 'acct_...', country: 'US', ... }     — fully working
    if (url.pathname === '/api/stripe/health') {
      if (!(await isAdmin())) return adminDenied();
      const stripe = getStripe(env);
      if (!stripe) {
        return jsonResponse({ configured: false });
      }
      try {
        // accounts.retrieve() with no args returns the account associated
        // with the secret key — cheapest possible health-check call.
        const account = await stripe.accounts.retrieve();
        const isTest = (env.STRIPE_SECRET_KEY || '').startsWith('sk_test_');
        return jsonResponse({
          configured: true,
          ok: true,
          mode: isTest ? 'test' : 'live',
          account_id: account.id,
          country: account.country || null,
          default_currency: account.default_currency || null,
          charges_enabled: !!account.charges_enabled,
          payouts_enabled: !!account.payouts_enabled,
          email: account.email || null,
        });
      } catch (err) {
        return jsonResponse({
          configured: true,
          ok: false,
          error: (err && err.message) || 'Stripe API call failed'
        });
      }
    }

    // ── Stripe webhook (public, signature-verified) ───────────────
    // Stripe POSTs payment lifecycle events here. We just acknowledge for
    // now — the real handler that updates booking records, sends emails,
    // etc. arrives with v72z (checkout flow). Logging in place so we can
    // see events flowing during v72w smoke-tests.
    //
    // Critical: signature verification MUST use constructEventAsync. The
    // synchronous constructEvent uses Node crypto APIs that don't exist on
    // Workers and fails silently (returns invalid signature even on valid
    // payloads). This is a well-known footgun — multiple Cloudflare/Stripe
    // tutorial blog posts have specifically warned about it.
    if (url.pathname === '/api/stripe/webhook') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }
      const stripe = getStripe(env);
      const signingSecret = env.STRIPE_WEBHOOK_SECRET;
      if (!stripe || !signingSecret) {
        console.error('[Stripe webhook] not configured (missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET)');
        return new Response('Webhook not configured', { status: 503 });
      }
      const signature = request.headers.get('stripe-signature');
      if (!signature) {
        return new Response('Missing signature', { status: 400 });
      }
      const rawBody = await request.text();
      let event;
      try {
        event = await stripe.webhooks.constructEventAsync(
          rawBody, signature, signingSecret
        );
      } catch (err) {
        console.error('[Stripe webhook] signature verification failed:', err.message);
        return new Response('Invalid signature', { status: 400 });
      }

      console.log('[Stripe webhook]', event.type, event.id);

      // v73q: handle checkout.session.completed → mark booking confirmed,
      // post system message, send Resend emails. All other event types are
      // logged-and-ack'd; we don't 4xx them so Stripe doesn't retry.
      //
      // v73ab: handle BOTH event types via a normalized shape. The inline
      // Payment Element flow fires payment_intent.succeeded; the redirect
      // Checkout flow fires checkout.session.completed. Below we adapt the
      // PaymentIntent to look like a Checkout Session so the rest of the
      // handler works unchanged.
      //
      // Field mapping (PI \u2192 session-shaped object we synthesize):
      //   pi.metadata        \u2192 session.metadata
      //   pi.id              \u2192 session.id (used for idempotency key + log)
      //   pi.id              \u2192 session.payment_intent (so booking.stripePaymentIntent is set)
      //   pi.amount_received \u2192 session.amount_total (cents paid)
      //
      // Idempotency relies on booking.stripeSessionId matching the incoming
      // event's session.id. Since PI events use pi.id as the synthesized
      // session.id, a PI retry will land on the same idempotency check.
      if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object;
        // Skip if this PaymentIntent came from a Checkout Session \u2014 that
        // payment will be processed via the matching checkout.session.completed
        // event. Without this guard we'd double-process redirect-flow payments.
        const fromCheckout = pi && pi.metadata && pi.metadata.fromCheckoutSession === 'true';
        // Detect by absence of our explicit inline marker. Stripe sets some
        // PI fields when the source is a Checkout Session, but the cleanest
        // signal is whether WE set inlineFlow=true in metadata at create-intent.
        const fromInline = pi && pi.metadata && pi.metadata.inlineFlow === 'true';
        if (!fromInline) {
          console.log('[Stripe webhook] payment_intent.succeeded ' + pi.id + ' not from inline flow \u2014 will be handled by checkout.session.completed instead');
          return jsonResponse({ received: true, type: event.type, status: 'deferred-to-checkout-session' });
        }
        // Adapt to session shape; existing handler below references session.*
        event.data.object = {
          id: pi.id,
          metadata: pi.metadata || {},
          amount_total: pi.amount_received || pi.amount || 0,
          payment_intent: pi.id,
        };
        // Rewrite the event type so the existing if-block below catches it.
        event.type = 'checkout.session.completed';
      }

      // Idempotency: Stripe retries webhooks on non-2xx. To handle a retry
      // of an already-processed event safely, we check booking.paymentStatus
      // before mutating. If already 'deposit_paid' with the same session id,
      // we 200 OK and skip side effects.
      if (event.type === 'checkout.session.completed') {
        try {
          const session = event.data.object;
          const meta = session.metadata || {};
          const offerId = meta.offerId;
          const bookingRef = meta.bookingRef;
          if (!offerId || !bookingRef) {
            console.error('[Stripe webhook] missing metadata on session ' + session.id);
            return jsonResponse({ received: true, type: event.type, error: 'missing metadata' });
          }

          const bookingRaw = await env.DOSSIERS.get('booking:' + bookingRef);
          if (!bookingRaw) {
            console.error('[Stripe webhook] booking ' + bookingRef + ' not found');
            return jsonResponse({ received: true, type: event.type, error: 'booking not found' });
          }
          const booking = JSON.parse(bookingRaw);

          // Idempotency guard
          if (booking.paymentStatus === 'deposit_paid' && booking.stripeSessionId === session.id) {
            console.log('[Stripe webhook] duplicate event for session ' + session.id + ' — already processed');
            return jsonResponse({ received: true, type: event.type, status: 'already-processed' });
          }

          const now = new Date().toISOString();
          const depositPaid = Number(session.amount_total || 0) / 100;

          // v73aa: snapshot the accepted offer's details onto the booking
          // so the customer's expandable detail view can read everything
          // from the booking record without an extra offer fetch. Read the
          // offer FIRST (before mutating the booking) so we have it in scope.
          let acceptedOffer = null;
          try {
            const offerRaw = await env.DOSSIERS.get('offer:' + offerId);
            if (offerRaw) acceptedOffer = JSON.parse(offerRaw);
          } catch (e) {
            console.error('[Stripe webhook] offer read for snapshot failed:', e && e.message);
          }

          // 1. Update booking
          booking.status = 'confirmed';
          booking.paymentStatus = 'deposit_paid';
          booking.stripeSessionId = session.id;
          booking.stripePaymentIntent = session.payment_intent || null;
          booking.depositPaidAmount = depositPaid;
          booking.depositPaidAt = now;
          booking.updatedAt = now;
          // v73aa: snapshot key offer fields for customer detail view.
          // Booking already has arrival/departure/room/guests (mutated on
          // offer-send), but we add the monetary + contract fields here.
          if (acceptedOffer) {
            booking.confirmed_total_amount = acceptedOffer.total_amount || 0;
            booking.confirmed_deposit_amount = acceptedOffer.deposit_amount || 0;
            booking.confirmed_balance_due_date = acceptedOffer.balance_due_date || '';
            booking.confirmed_inclusions = Array.isArray(acceptedOffer.inclusions) ? acceptedOffer.inclusions : [];
            booking.confirmed_exclusions = acceptedOffer.exclusions || '';
            booking.confirmed_cancellation_terms = acceptedOffer.cancellation_terms || '';
            booking.confirmed_partner_notes = acceptedOffer.partner_notes || '';
            booking.confirmed_offer_id = acceptedOffer.id;
            booking.confirmed_currency = acceptedOffer.currency || 'USD';
          }
          await env.DOSSIERS.put('booking:' + bookingRef, JSON.stringify(booking));

          // 2. Update offer (mark accepted)
          try {
            if (acceptedOffer) {
              acceptedOffer.status = 'accepted';
              acceptedOffer.responded_at = now;
              acceptedOffer.stripeSessionId = session.id;
              await env.DOSSIERS.put('offer:' + offerId, JSON.stringify(acceptedOffer));
            }
          } catch (e) {
            console.error('[Stripe webhook] offer update failed:', e && e.message);
          }

          // 3. Post system message into conversation
          // v73x: fall back to metadata.conversationId if the booking record
          // doesn't have it. Some older bookings created before the standard
          // enquiry flow may be missing the field; the Stripe session metadata
          // captures it at create-session time so we have a backup reference.
          // Also: explicit logging at every branch so we can diagnose silent
          // skips without guessing. v73w investigation found a booking whose
          // system message never posted with no error log — turned out the
          // if(convId) check was falsy. Don't want to repeat that.
          const convId = booking.conversationId || meta.conversationId || null;
          if (!convId) {
            console.error('[Stripe webhook] NO conversationId on booking ' + bookingRef + ' AND no fallback in metadata. System message will NOT be posted. Booking is still confirmed.');
          } else {
            try {
              const convRaw = await env.DOSSIERS.get('conversation:' + convId);
              if (!convRaw) {
                console.error('[Stripe webhook] booking ' + bookingRef + ' references conversation ' + convId + ' but that conversation does not exist in KV. System message NOT posted.');
              } else {
                const conv = JSON.parse(convRaw);
                const msgsRaw = await env.DOSSIERS.get('conversation:' + convId + ':messages');
                const messages = msgsRaw ? JSON.parse(msgsRaw) : [];
                const sysMsg = {
                  id: 'msg_' + Date.now() + '_paid',
                  role: 'system',
                  type: 'booking_confirmed',
                  text: '✓ Deposit paid · Booking confirmed · ' + bookingRef + '\n\n$' + depositPaid.toLocaleString() + ' received. The property has been notified.',
                  senderName: 'The Bearing',
                  sentAt: now,
                  readAt: null,
                  bookingRef: bookingRef,
                };
                messages.push(sysMsg);
                conv.lastMessageAt = now;
                conv.lastMessagePreview = '✓ Booking confirmed';
                conv.unreadGuest = (conv.unreadGuest || 0);  // not bumped — customer just paid, no surprise
                conv.unreadAdmin = (conv.unreadAdmin || 0) + 1; // bump admin/partner

                // v73x: if booking record had no conversationId, write it back
                // now so future operations on this booking find the conversation
                // directly. Self-healing.
                if (!booking.conversationId) {
                  console.log('[Stripe webhook] booking ' + bookingRef + ' had no conversationId; backfilling from metadata: ' + convId);
                  booking.conversationId = convId;
                  await env.DOSSIERS.put('booking:' + bookingRef, JSON.stringify(booking));
                }

                await env.DOSSIERS.put('conversation:' + convId, JSON.stringify(conv));
                await env.DOSSIERS.put('conversation:' + convId + ':messages', JSON.stringify(messages));
                console.log('[Stripe webhook] posted booking_confirmed system message to conversation ' + convId);
                // v73y: refresh the cached unread counters so partner sidebar
                // badge picks up the new message immediately. Previously this
                // was skipped, causing the badge to stay at 0 even though
                // the conversation had a new system message after deposit
                // payment. Same pattern as other places that write conv.unread*
                // (admin reply at line 2042, decline at line 3309, etc.) —
                // each writer is responsible for triggering recompute.
                try { await recomputeUnreadCounters(env); } catch(_) {}
              }
            } catch (e) {
              console.error('[Stripe webhook] conversation message post failed:', e && e.message);
            }
          }

          // 4. Send Resend emails (customer + admin + partner)
          // Email recipient strategy:
          //   - Customer: booking.email
          //   - Admin: loadNotificationRecipients() — configurable in admin-settings
          //   - Partner: admin@thebearing.io (placeholder until partner auth has
          //     real contact emails per property — flagged in handoff)
          if (env.RESEND_API_KEY) {
            const customerEmail = booking.email;
            const adminRecipients = await loadNotificationRecipients(env);
            const partnerEmail = 'admin@thebearing.io'; // placeholder, see note above
            const propName = booking.property || booking.slug || 'Property';
            const stayLine = (booking.arrival && booking.departure)
              ? booking.arrival + ' → ' + booking.departure + (booking.nights ? ' · ' + booking.nights + ' nights' : '')
              : '';
            const roomLine = booking.room || '';
            const guestName = (booking.firstname || '') + (booking.lastname ? ' ' + booking.lastname : '');

            // Customer confirmation
            if (customerEmail) {
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                  'Authorization': 'Bearer ' + env.RESEND_API_KEY,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  from: 'The Bearing <bookings@thebearing.io>',
                  to: [customerEmail],
                  subject: 'Booking confirmed · ' + propName + ' · ' + bookingRef,
                  html: '<div style="font-family:Geist,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#faf7f1;color:#1e1810;">'
                    + '<div style="font-size:.62rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#b05830;">The Bearing</div>'
                    + '<h1 style="font-family:\'Instrument Serif\',Georgia,serif;font-size:1.8rem;line-height:1.2;margin:8px 0 18px;font-weight:400;">Your booking is confirmed.</h1>'
                    + '<p style="line-height:1.55;margin:0 0 18px;">Hi ' + (guestName || 'there') + ', your deposit of <strong>$' + depositPaid.toLocaleString() + '</strong> has been received and your stay at <strong>' + propName + '</strong> is confirmed.</p>'
                    + '<div style="background:#fff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px;margin:18px 0;">'
                    + '<div style="font-size:.7rem;color:#7a6a58;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">Booking</div>'
                    + '<div style="font-family:\'Instrument Serif\',Georgia,serif;font-size:1.2rem;margin-bottom:6px;">' + propName + '</div>'
                    + (stayLine ? '<div style="color:#5a4a38;margin-bottom:4px;">' + stayLine + '</div>' : '')
                    + (roomLine ? '<div style="color:#5a4a38;margin-bottom:4px;">' + roomLine + '</div>' : '')
                    + '<div style="color:#7a6a58;font-size:.85rem;margin-top:10px;">Reference: <strong>' + bookingRef + '</strong></div>'
                    + '</div>'
                    + '<p style="line-height:1.55;margin:0 0 12px;">The property has been notified and will be in touch directly with check-in details and any remaining balance.</p>'
                    + '<p style="line-height:1.55;margin:0 0 12px;">You can view this booking anytime at <a href="https://thebearing.io/bookings" style="color:#b05830;">thebearing.io/bookings</a>.</p>'
                    + '<p style="margin:32px 0 0;color:#7a6a58;font-size:.85rem;">Bon voyage,<br>The Bearing</p>'
                    + '</div>',
                }),
              }).catch(function(e) { console.error('[Stripe webhook] customer email failed:', e); });
            }

            // Admin notification
            if (adminRecipients.length) {
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                  'Authorization': 'Bearer ' + env.RESEND_API_KEY,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  from: 'The Bearing Bookings <bookings@thebearing.io>',
                  to: adminRecipients,
                  subject: '[CONFIRMED] ' + propName + ' · ' + bookingRef + ' · $' + depositPaid.toLocaleString(),
                  html: '<div style="font-family:Geist,system-ui,sans-serif;padding:24px;">'
                    + '<h2 style="font-family:\'Instrument Serif\',Georgia,serif;font-weight:400;margin:0 0 12px;">Booking confirmed</h2>'
                    + '<p><strong>' + propName + '</strong></p>'
                    + (stayLine ? '<p>' + stayLine + '</p>' : '')
                    + (roomLine ? '<p>Room: ' + roomLine + '</p>' : '')
                    + '<p>Guest: ' + (guestName || customerEmail || 'unknown') + ' · ' + (customerEmail || 'no email') + '</p>'
                    + '<p>Deposit paid: <strong>$' + depositPaid.toLocaleString() + '</strong></p>'
                    + '<p>Reference: <code>' + bookingRef + '</code></p>'
                    + '<p>Stripe session: <code>' + session.id + '</code></p>'
                    + '<p style="margin-top:24px;"><a href="https://thebearing.io/admin-bookings">View in admin</a></p>'
                    + '</div>',
                }),
              }).catch(function(e) { console.error('[Stripe webhook] admin email failed:', e); });
            }

            // Partner notification (currently same as admin baseline)
            if (partnerEmail && adminRecipients.indexOf(partnerEmail) === -1) {
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                  'Authorization': 'Bearer ' + env.RESEND_API_KEY,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  from: 'The Bearing Bookings <bookings@thebearing.io>',
                  to: [partnerEmail],
                  subject: '[PARTNER] New confirmed booking · ' + propName + ' · ' + bookingRef,
                  html: '<div style="font-family:Geist,system-ui,sans-serif;padding:24px;">'
                    + '<h2 style="font-family:\'Instrument Serif\',Georgia,serif;font-weight:400;margin:0 0 12px;">New confirmed booking</h2>'
                    + '<p>You have a confirmed booking at <strong>' + propName + '</strong>.</p>'
                    + (stayLine ? '<p>' + stayLine + '</p>' : '')
                    + (roomLine ? '<p>Room: ' + roomLine + '</p>' : '')
                    + '<p>Guest: ' + (guestName || customerEmail || 'unknown') + ' · ' + (customerEmail || 'no email') + '</p>'
                    + '<p>Reference: <code>' + bookingRef + '</code></p>'
                    + '<p style="margin-top:24px;">The guest will receive their own confirmation. Please reach out directly to coordinate check-in and remaining balance.</p>'
                    + '</div>',
                }),
              }).catch(function(e) { console.error('[Stripe webhook] partner email failed:', e); });
            }
          } else {
            console.warn('[Stripe webhook] RESEND_API_KEY not set — skipping notifications for ' + bookingRef);
          }

          console.log('[Stripe webhook] booking ' + bookingRef + ' confirmed via session ' + session.id);
        } catch (err) {
          // Catch-all so we still 200 the webhook even if KV/Resend errors —
          // Stripe doesn't need to retry for our infra bugs. Errors are logged
          // and visible in admin-bookings (booking will show as cancelled-but-
          // -paid which is a useful signal for manual intervention).
          console.error('[Stripe webhook] processing error for event ' + event.id + ':', err && (err.stack || err.message));
        }
      }

      return jsonResponse({ received: true, type: event.type, id: event.id });
    }

    // ── Everything else → static assets ───────────────────────────
    return env.ASSETS.fetch(request);
  },

  // ── Scheduled cron handler ────────────────────────────────────
  // Configured in wrangler.toml under [triggers] crons = ["0 * * * *"]
  // Runs hourly and sends staleness reminders for conversations awaiting admin reply.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runStaleConvReminders(env));
  }
};

// Staleness thresholds in milliseconds
const REMINDER_24H = 24 * 60 * 60 * 1000;
const REMINDER_48H = 48 * 60 * 60 * 1000;
const REMINDER_72H = 72 * 60 * 60 * 1000;

async function runStaleConvReminders(env) {
  const startedAt = Date.now();
  // Record skipped runs so the health card distinguishes "skipped because Resend
  // missing" from "actually never ran." Without this, an early return left
  // __cron:last_run unwritten and the health card stayed amber forever.
  if (!env.DOSSIERS) {
    console.log('[Cron] Skipping — DOSSIERS not bound');
    return;
  }
  if (!env.RESEND_API_KEY) {
    console.log('[Cron] Skipping — RESEND_API_KEY missing');
    try {
      await env.DOSSIERS.put('__cron:last_run', JSON.stringify({
        ranAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        scanned: 0,
        sent: 0,
        ok: true,
        skipped: 'RESEND_API_KEY missing — no escalations could be sent'
      }));
    } catch(_) {}
    return;
  }
  let scanned = 0, sent = 0;
  const adminRecipients = await loadNotificationRecipients(env);

  try {
    const idxRaw = await env.DOSSIERS.get('__conversations_index');
    const ids = idxRaw ? JSON.parse(idxRaw) : [];
    const now = Date.now();

    for (const id of ids) {
      const convRaw = await env.DOSSIERS.get('conversation:' + id);
      if (!convRaw) continue;
      let conv;
      try { conv = JSON.parse(convRaw); } catch(e) { continue; }
      scanned++;

      // Only conversations where admin owes a reply and aren't archived
      if (conv.status === 'archived') continue;
      if (!(conv.unreadAdmin || 0)) continue;
      if (!conv.lastMessageAt) continue;

      const waiting = now - new Date(conv.lastMessageAt).getTime();
      const reminders = conv.reminders || {};

      let level = null;
      if (waiting >= REMINDER_72H && !reminders.sent72At) level = 72;
      else if (waiting >= REMINDER_48H && !reminders.sent48At) level = 48;
      else if (waiting >= REMINDER_24H && !reminders.sent24At) level = 24;

      if (!level) continue;

      // Look up property contact email
      let partnerEmail = null;
      let partnerName = conv.propertyName || conv.propertySlug;
      if (conv.propertySlug) {
        try {
          const propRaw = await env.DOSSIERS.get(conv.propertySlug + ':property');
          if (propRaw) {
            const prop = JSON.parse(propRaw);
            if (prop && prop.contact && prop.contact.email) {
              partnerEmail = prop.contact.email;
            }
            if (prop && prop.name) partnerName = prop.name;
          }
        } catch(e) {}
      }

      const replyUrl = 'https://thebearing.io/admin-conversations.html?id=' + encodeURIComponent(id);
      const ppUrl = 'https://thebearing.io/pp-conversations.html?id=' + encodeURIComponent(id);
      const preview = (conv.lastMessagePreview || '').substring(0, 200);
      const guestLabel = conv.guestName || conv.guestEmail || 'A guest';

      const subjects = {
        24: `${guestLabel} is waiting on a reply — ${partnerName}`,
        48: `Still waiting: ${guestLabel} — ${partnerName} (48h)`,
        72: `Urgent: ${guestLabel} has been waiting 3+ days — ${partnerName}`
      };
      const tones = {
        24: 'A guest has been waiting for a response for over 24 hours.',
        48: 'This guest has now been waiting over 48 hours. Please respond as soon as possible.',
        72: 'This guest has been waiting more than 3 days. The enquiry risks being lost — please reply or escalate.'
      };

      const partnerBody = `${tones[level]}\n\nGuest: ${guestLabel}\nProperty: ${partnerName}\nLast message:\n"${preview}"\n\nReply directly via the partner portal: ${ppUrl}\n\n— The Bearing`;
      const adminBody = `Stale conversation (${level}h+ wait).\n\nGuest: ${guestLabel}\nProperty: ${partnerName}\nLast message:\n"${preview}"\n\nView conversation: ${replyUrl}\n\n— The Bearing reminder system`;

      // 24h: notify partner only. 48h+: notify partner AND admin.
      const sendPromises = [];
      const notifyPartner = partnerEmail && conv.notifyPartner !== false;
      const notifyAdmin = conv.notifyAdmin !== false;

      if (notifyPartner) {
        sendPromises.push(fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'The Bearing <bookings@thebearing.io>',
            to: [partnerEmail],
            subject: subjects[level],
            text: partnerBody
          })
        }).catch(function(e) { console.log('[Cron] partner mail err:', e.message); }));
      }

      if (level >= 48 && notifyAdmin) {
        sendPromises.push(fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'The Bearing <bookings@thebearing.io>',
            to: adminRecipients,
            subject: subjects[level],
            text: adminBody
          })
        }).catch(function(e) { console.log('[Cron] admin mail err:', e.message); }));
      }

      try { await Promise.all(sendPromises); } catch(e) {}

      // Mark this level as sent
      conv.reminders = conv.reminders || {};
      const nowIso = new Date().toISOString();
      if (level === 24) conv.reminders.sent24At = nowIso;
      if (level === 48) conv.reminders.sent48At = nowIso;
      if (level === 72) conv.reminders.sent72At = nowIso;
      conv.reminders.lastSentLevel = level;
      conv.reminders.lastSentAt = nowIso;

      await env.DOSSIERS.put('conversation:' + id, JSON.stringify(conv));
      sent++;
      console.log(`[Cron] Sent ${level}h reminder for conv ${id} — partner=${notifyPartner}, admin=${level>=48 && notifyAdmin}`);
    }

    console.log(`[Cron] Done in ${Date.now()-startedAt}ms. Scanned ${scanned}, sent ${sent} reminders.`);
    // Record run for system health check
    try {
      await env.DOSSIERS.put('__cron:last_run', JSON.stringify({
        ranAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        scanned: scanned,
        sent: sent,
        ok: true
      }));
    } catch(_) {}
  } catch(e) {
    console.error('[Cron] Fatal error:', e.message);
    try {
      await env.DOSSIERS.put('__cron:last_run', JSON.stringify({
        ranAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        scanned: scanned,
        sent: sent,
        ok: false,
        error: String(e && e.message || e)
      }));
    } catch(_) {}
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ── Settings helpers ──────────────────────────────────────────────
// Notification recipients and admin allowlist are persisted in KV so they can be
// edited via admin-settings.html without redeploying. The baseline address
// `admin@thebearing.io` (also the admin login) is always merged in as a failsafe
// so notifications never silently break and admin access can never be lost.

const BASELINE_NOTIFICATION_RECIPIENT = 'admin@thebearing.io';

async function loadNotificationRecipients(env) {
  if (!env.DOSSIERS) return [BASELINE_NOTIFICATION_RECIPIENT];
  try {
    const raw = await env.DOSSIERS.get('__settings:notifications');
    if (!raw) return [BASELINE_NOTIFICATION_RECIPIENT];
    const obj = JSON.parse(raw);
    const list = Array.isArray(obj && obj.recipients) ? obj.recipients : [];
    // dedupe + lowercase + baseline merge so we always notify the founder
    const seen = {}; const out = [];
    [BASELINE_NOTIFICATION_RECIPIENT].concat(list).forEach(function(e) {
      const lc = String(e || '').toLowerCase().trim();
      if (lc && !seen[lc]) { seen[lc] = 1; out.push(lc); }
    });
    return out.length ? out : [BASELINE_NOTIFICATION_RECIPIENT];
  } catch(e) {
    console.error('[Settings] notif load error:', e.message);
    return [BASELINE_NOTIFICATION_RECIPIENT];
  }
}

async function loadAllowlistExtras(env) {
  if (!env.DOSSIERS) return [];
  try {
    const raw = await env.DOSSIERS.get('__settings:allowlist');
    if (!raw) return [];
    const obj = JSON.parse(raw);
    const list = Array.isArray(obj && obj.emails) ? obj.emails : [];
    return list.map(function(e) { return String(e || '').toLowerCase().trim(); }).filter(Boolean);
  } catch(e) {
    console.error('[Settings] allowlist load error:', e.message);
    return [];
  }
}


// Recomputes the aggregated unread counters from all conversations.
// Cheap because conv list is small and KV ops are bulk-readable.
async function recomputeUnreadCounters(env) {
  if (!env.DOSSIERS) return;
  try {
    const idxRaw = await env.DOSSIERS.get('__conversations_index');
    const ids = idxRaw ? JSON.parse(idxRaw) : [];
    let admin = 0;
    const guests = {};
    const props = {};
    for (const id of ids) {
      const cRaw = await env.DOSSIERS.get('conversation:' + id);
      if (!cRaw) continue;
      const c = JSON.parse(cRaw);
      if (c.status === 'archived') continue;
      if ((c.unreadAdmin || 0) > 0) admin++;
      if ((c.unreadGuest || 0) > 0 && c.guestId) {
        guests[c.guestId] = (guests[c.guestId] || 0) + (c.unreadGuest || 0);
      }
      // Partner unread piggybacks on unreadAdmin (same recipient pool currently)
      if ((c.unreadAdmin || 0) > 0 && c.propertySlug) {
        props[c.propertySlug] = (props[c.propertySlug] || 0) + 1;
      }
    }
    await env.DOSSIERS.put('__unread_counters', JSON.stringify({ admin, guests, props }), { expirationTtl: 86400 });
  } catch(e) { console.error('[Counters] recompute error:', e.message); }
}

async function handleClerkEvent(event, env) {
  if (!env.DOSSIERS) return;
  const type = event.type;
  const data = event.data;
  if (type === 'user.created' || type === 'user.updated') {
    const email = (data.email_addresses || []).find(e => e.id === data.primary_email_address_id);
    const oauth = (data.external_accounts || [])[0];
    // Read existing record so admin-edited fields (tier, notes, preferences, location, etc.) survive webhook updates
    const existingRaw = await env.DOSSIERS.get('member:' + data.id);
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    const member = {
      // Clerk-owned fields — always refreshed from Clerk payload (source of truth)
      id: data.id,
      email: email ? email.email_address : (existing.email || ''),
      name: [data.first_name, data.last_name].filter(Boolean).join(' ') || (email ? email.email_address.split('@')[0] : (existing.name || '')),
      provider: oauth ? oauth.provider : (existing.provider || 'email'),
      avatar: data.image_url || existing.avatar || '',
      joined_at: existing.joined_at || new Date(data.created_at).toISOString(),
      // Admin-editable fields — preserved from existing record, or default on first-time creation
      tier: existing.tier || 'member',
      location: existing.location || '',
      bookings: existing.bookings || 0,
      ltv: existing.ltv || 0,
      preferences: existing.preferences || {},
      notes: existing.notes || '',
      // System-managed
      last_active: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await env.DOSSIERS.put('member:' + data.id, JSON.stringify(member));
    const rawIndex = await env.DOSSIERS.get('__members_index');
    let ids = rawIndex ? JSON.parse(rawIndex) : [];
    if (!ids.includes(data.id)) { ids.push(data.id); await env.DOSSIERS.put('__members_index', JSON.stringify(ids)); }
  }
  if (type === 'user.deleted') {
    await env.DOSSIERS.delete('member:' + data.id);
    const rawIndex = await env.DOSSIERS.get('__members_index');
    let ids = rawIndex ? JSON.parse(rawIndex) : [];
    ids = ids.filter(i => i !== data.id);
    await env.DOSSIERS.put('__members_index', JSON.stringify(ids));
  }
}