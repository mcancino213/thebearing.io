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

    // ── v75f: requester identity + partner authorization helpers ──
    //
    // getRequesterUserId() — returns the Clerk user_id of the requester, or
    // null if no valid session token was sent. Verifies via the Clerk
    // backend API (using CLERK_SECRET_KEY). This is the same path admin's
    // isAdmin() uses, just returning the user_id instead of an authz boolean.
    //
    // Result is cached on the closure to avoid double-verifying within one
    // request (e.g. when an endpoint checks identity then calls a helper
    // that also checks).
    let cachedUserId = undefined;  // undefined = not yet checked, null = no auth, string = verified id
    async function getRequesterUserId() {
      if (cachedUserId !== undefined) return cachedUserId;
      const sessionToken = request.headers.get('X-Clerk-Session');
      if (!sessionToken || !env.CLERK_SECRET_KEY) {
        cachedUserId = null;
        return null;
      }
      try {
        // The /sessions/{sid} endpoint returns session metadata including user_id.
        // (Different from /sessions/{sid}/tokens which returns a JWT.)
        const r = await fetch('https://api.clerk.com/v1/sessions/' + sessionToken, {
          headers: { 'Authorization': 'Bearer ' + env.CLERK_SECRET_KEY }
        });
        if (!r.ok) {
          console.log('[identity] session fetch failed:', r.status);
          cachedUserId = null;
          return null;
        }
        const data = await r.json();
        // Session response includes `user_id` and `status` ('active','expired',...)
        if (data.status !== 'active') {
          console.log('[identity] session not active:', data.status);
          cachedUserId = null;
          return null;
        }
        cachedUserId = data.user_id || null;
        return cachedUserId;
      } catch(e) {
        console.log('[identity] verify exception:', e.message);
        cachedUserId = null;
        return null;
      }
    }

    // isPartnerOf(slug, userId) — returns true if `userId` appears in the
    // property's partnerUserIds list. Used to authorize partner data fetches
    // (e.g. /api/booking?slug=X, /api/conversation?slug=X).
    async function isPartnerOf(slug, userId) {
      if (!slug || !userId) return false;
      try {
        const raw = await env.DOSSIERS.get(slug + ':property');
        if (!raw) return false;
        const data = JSON.parse(raw);
        const ids = Array.isArray(data.partnerUserIds) ? data.partnerUserIds : [];
        return ids.indexOf(userId) !== -1;
      } catch(e) {
        console.log('[isPartnerOf] error:', e.message);
        return false;
      }
    }

    // partnerDenied() — uniform 403 response shape for partner gate failures.
    // Distinct error message helps the client know to redirect to /pp-login
    // vs other failure modes.
    function partnerDenied(reason) {
      return jsonResponse({ error: 'partner access required', reason: reason || 'unauthorized' }, 403);
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
          // v75b: partnerUserIds — Clerk user ids permitted to edit this
          // property via the partner-listing endpoint. Empty default; admin
          // populates it via admin-property-editor. Used by /api/partner-listing
          // to verify the requester is an authorized partner for this property.
          if (!Array.isArray(data.partnerUserIds)) {
            data.partnerUserIds = [];
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

        // v73al: validate partner_emails field if provided. Must be an array
        // of valid email strings. Empty array is allowed (will fall back to
        // PARTNER_EMAIL_TRANSITION_DEFAULT for notifications). Log a warning
        // so we can see in Cloudflare logs which properties are saving without
        // partner_emails set.
        if (body.property.partner_emails !== undefined) {
          if (!Array.isArray(body.property.partner_emails)) {
            return jsonResponse({ error: 'partner_emails must be an array of email addresses' }, 400);
          }
          const cleaned = [];
          for (const raw of body.property.partner_emails) {
            const lc = String(raw || '').toLowerCase().trim();
            if (!lc) continue;
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lc)) {
              return jsonResponse({ error: 'invalid email in partner_emails: ' + lc }, 400);
            }
            if (cleaned.indexOf(lc) === -1) cleaned.push(lc);
          }
          body.property.partner_emails = cleaned;
        }
        if (!body.property.partner_emails || body.property.partner_emails.length === 0) {
          console.warn('[Property POST] slug "' + slugVal + '" has no partner_emails \u2014 notifications will fall back to transition default. Set partner_emails in admin-property-editor.');
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
          // v74v: defensive — these are stale ENQUIRIES (no deposit paid),
          // so credits shouldn't exist yet. The void is a no-op in that case
          // but cheap and safe.
          try { await creditsVoidOnCancellation(env, booking); } catch(e) {}
          // v74w: same defensive cleanup for FM (stale enquiries never had
          // deposit paid, so no FM was reserved — void is a no-op).
          try { await foundingMemberVoidIfPendingForBooking(env, booking); } catch(e) {}
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

    // ── /api/booking/mark-seen ────────────────────────────────────
    // v73ah: clear seenByPartner / seenByAdmin flag on a confirmed booking.
    // Called when the partner or admin opens the booking detail view. Used
    // by the Bookings sidebar badge to count "newly confirmed, unseen" items.
    //
    // POST body: { ref, role: 'partner' | 'admin' }
    // - Partner role requires no auth beyond knowing the booking ref (the
    //   partner already sees these bookings on pp-bookings; this is just
    //   a UI bookkeeping signal, not a security boundary). Real partner
    //   auth is on the deferred-items list.
    // - Admin role requires admin auth (isAdmin check).
    if (url.pathname === '/api/booking/mark-seen') {
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      let body;
      try { body = await request.json(); }
      catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
      const { ref, role } = body;
      if (!ref) return jsonResponse({ error: 'ref required' }, 400);
      if (role !== 'partner' && role !== 'admin') {
        return jsonResponse({ error: 'role must be partner or admin' }, 400);
      }
      if (role === 'admin' && !(await isAdmin())) return adminDenied();

      const bookingRaw = await env.DOSSIERS.get('booking:' + ref);
      if (!bookingRaw) return jsonResponse({ error: 'booking not found' }, 404);
      const booking = JSON.parse(bookingRaw);

      if (role === 'partner') booking.seenByPartner = true;
      if (role === 'admin')   booking.seenByAdmin = true;
      booking.updatedAt = new Date().toISOString();

      await env.DOSSIERS.put('booking:' + ref, JSON.stringify(booking));
      return jsonResponse({ ok: true, ref: ref, role: role });
    }

    // ── /api/credits ──────────────────────────────────────────────
    // v74v: Reserve Credits endpoints.
    //
    //   GET  /api/credits/me?guestId=user_X    → guest reads own balance + history
    //   GET  /api/credits/admin?memberId=X     → admin reads any guest (admin-gated)
    //   POST /api/credits/admin/adjust         → admin manual ledger entry (admin-gated)
    //   POST /api/credits/admin/redeem         → admin manual redemption marking (admin-gated)
    //   POST /api/credits/admin/run-promotion  → admin manual trigger of promote+expire scan
    //
    // Balances are ALWAYS computed from the ledger by creditsComputeBalances.
    // Returned shape:
    //   {
    //     pendingCents, earnedCents, usedCents, voidedCents, expiredCents,
    //     redeemableMilestones, goalCents, expiresAt, lastEarnedAt,
    //     ledger: [...entries sorted by createdAt desc]
    //   }
    if (url.pathname === '/api/credits/me') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);
      // Guest auth: identify by guestId query param (mirrors how other guest-
      // facing read endpoints work in this worker). Production should verify
      // against Clerk session, but for now trust the param consistent with
      // existing patterns elsewhere in this file.
      const guestId = url.searchParams.get('guestId');
      if (!guestId) return jsonResponse({ error: 'guestId required' }, 400);
      if (request.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405);
      const state = await creditsLoadLedger(env, guestId);
      const balances = creditsComputeBalances(state.ledger);
      // Sort ledger desc by createdAt for display
      const sortedLedger = state.ledger.slice().sort(function(a, b) {
        return (b.createdAt || '').localeCompare(a.createdAt || '');
      });
      return jsonResponse({
        ok: true,
        memberId: guestId,
        goalCents: CREDITS_GOAL_CENTS,
        rate: CREDITS_RATE,
        excludedSlugs: CREDITS_EXCLUDED_SLUGS,
        ...balances,
        ledger: sortedLedger,
      });
    }

    if (url.pathname === '/api/credits/admin' || url.pathname === '/api/credits/admin/') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);
      if (!(await isAdmin(request, env))) return adminDenied();
      if (request.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405);
      // Two modes:
      //   ?memberId=X → return that member's full state
      //   no param    → return all members with non-empty ledgers (list view)
      const memberId = url.searchParams.get('memberId');
      if (memberId) {
        const state = await creditsLoadLedger(env, memberId);
        const balances = creditsComputeBalances(state.ledger);
        const sortedLedger = state.ledger.slice().sort(function(a, b) {
          return (b.createdAt || '').localeCompare(a.createdAt || '');
        });
        return jsonResponse({
          ok: true, memberId, goalCents: CREDITS_GOAL_CENTS,
          ...balances, ledger: sortedLedger
        });
      }
      // List view: scan __members_index, pull credit balance for each.
      // For now this is a linear scan — fine for current member counts (<10K).
      try {
        const rawIdx = await env.DOSSIERS.get('__members_index');
        const ids = rawIdx ? JSON.parse(rawIdx) : [];
        const members = [];
        for (const id of ids) {
          const state = await creditsLoadLedger(env, id);
          if (!state.ledger.length) continue; // skip members with no credit activity
          const balances = creditsComputeBalances(state.ledger);
          // Fetch the member record for display name/email
          let displayName = '', displayEmail = '';
          try {
            const memRaw = await env.DOSSIERS.get('member:' + id);
            if (memRaw) {
              const m = JSON.parse(memRaw);
              displayName = [m.firstName, m.lastName].filter(Boolean).join(' ') || '';
              const emails = Array.isArray(m.emailAddresses) ? m.emailAddresses : [];
              displayEmail = (emails[0] && (emails[0].emailAddress || emails[0])) || m.email || '';
            }
          } catch(e) {}
          members.push({
            memberId: id,
            displayName, displayEmail,
            pendingCents: balances.pendingCents,
            earnedCents: balances.earnedCents,
            usedCents: balances.usedCents,
            redeemableMilestones: balances.redeemableMilestones,
            expiresAt: balances.expiresAt,
            lastEarnedAt: balances.lastEarnedAt,
            ledgerEntries: state.ledger.length,
          });
        }
        // Sort by earnedCents desc
        members.sort(function(a, b) { return b.earnedCents - a.earnedCents; });
        return jsonResponse({ ok: true, goalCents: CREDITS_GOAL_CENTS, members });
      } catch (e) {
        console.error('[credits/admin list] failed:', e);
        return jsonResponse({ error: String(e && e.message || e) }, 500);
      }
    }

    if (url.pathname === '/api/credits/admin/adjust') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);
      if (!(await isAdmin(request, env))) return adminDenied();
      if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
      try {
        const body = await request.json();
        const { memberId, amountCents, asStatus, reason, actor } = body;
        if (!memberId) return jsonResponse({ error: 'memberId required' }, 400);
        const amt = Number(amountCents);
        if (!Number.isFinite(amt) || amt === 0) return jsonResponse({ error: 'amountCents must be non-zero number' }, 400);
        if (!reason || !reason.trim()) return jsonResponse({ error: 'reason required' }, 400);
        const status = asStatus === 'pending' ? 'pending' : 'earned';
        const state = await creditsLoadLedger(env, memberId);
        const entry = {
          id: creditsNewId(),
          type: 'adjust',
          status,
          amount: Math.round(amt),
          reason: reason.trim(),
          actor: actor || 'admin',
          createdAt: new Date().toISOString(),
        };
        if (status === 'earned') entry.promotedAt = entry.createdAt;
        state.ledger.push(entry);
        await creditsSaveLedger(env, memberId, state.ledger);
        return jsonResponse({ ok: true, entry });
      } catch (e) {
        return jsonResponse({ error: String(e && e.message || e) }, 500);
      }
    }

    if (url.pathname === '/api/credits/admin/redeem') {
      // Admin manually marks a redemption (offline use, comp, etc.).
      // The booking-flow redemption is hooked separately at offer-accept time.
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);
      if (!(await isAdmin(request, env))) return adminDenied();
      if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
      try {
        const body = await request.json();
        const { memberId, redemptionBookingRef, actor, note } = body;
        if (!memberId) return jsonResponse({ error: 'memberId required' }, 400);
        if (!redemptionBookingRef) return jsonResponse({ error: 'redemptionBookingRef required' }, 400);
        const res = await creditsRedeem(env, memberId, redemptionBookingRef);
        if (!res.ok) return jsonResponse({ error: res.error || 'redemption failed', detail: res }, 400);
        // Optionally record the actor + note on the redeem entry
        if (actor || note) {
          const state = await creditsLoadLedger(env, memberId);
          const entry = state.ledger.find(function(e) { return e.id === res.entryId; });
          if (entry) {
            if (actor) entry.actor = actor;
            if (note) entry.reason = note;
            await creditsSaveLedger(env, memberId, state.ledger);
          }
        }
        return jsonResponse({ ok: true, ...res });
      } catch (e) {
        return jsonResponse({ error: String(e && e.message || e) }, 500);
      }
    }

    if (url.pathname === '/api/credits/admin/run-promotion') {
      // Manually trigger the daily promotion/expiry scan. Useful for testing
      // and for emergency runs if the scheduled cron failed.
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);
      if (!(await isAdmin(request, env))) return adminDenied();
      if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
      try {
        const result = await creditsRunPromotionScan(env);
        return jsonResponse({ ok: true, ...result });
      } catch (e) {
        return jsonResponse({ error: String(e && e.message || e) }, 500);
      }
    }

    // ── /api/founding-member ──────────────────────────────────────
    // v74w: Founding Member status endpoints.
    //
    //   GET  /api/founding-member/me?guestId=X     — guest reads own status
    //   GET  /api/founding-member/stats            — public counter (founding-member.html)
    //   POST /api/founding-member/admin/grant      — admin manual grant (admin-gated)
    //   POST /api/founding-member/admin/revoke     — admin manual revoke (admin-gated)
    //   POST /api/founding-member/admin/run-scan   — manual promotion-scan trigger
    if (url.pathname === '/api/founding-member/me') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);
      if (request.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405);
      const guestId = url.searchParams.get('guestId');
      if (!guestId) return jsonResponse({ error: 'guestId required' }, 400);
      const member = await fmLoadMember(env, guestId);
      if (!member || !member.foundingMember || member.foundingMember.status === 'voided') {
        return jsonResponse({ ok: true, status: 'none', cap: FOUNDING_MEMBER_CAP });
      }
      const fm = member.foundingMember;
      return jsonResponse({
        ok: true,
        status: fm.status,
        number: fm.number,
        reservedAt: fm.reservedAt,
        awardedAt: fm.awardedAt || null,
        cap: FOUNDING_MEMBER_CAP,
      });
    }

    if (url.pathname === '/api/founding-member/stats') {
      // Public read — no auth. Used by founding-member.html to display the
      // "X of 1,000 spots taken" counter. Returns combined (reserved+awarded)
      // total per Miguel's v74w decision #3.
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);
      if (request.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405);
      const counter = await fmLoadCounter(env);
      const reserved = counter.reservedCount || 0;
      const awarded = counter.awardedCount || 0;
      const total = reserved + awarded;
      const cap = counter.cap || FOUNDING_MEMBER_CAP;
      return jsonResponse({
        ok: true,
        reservedCount: reserved,
        awardedCount: awarded,
        totalCount: total,
        cap,
        remaining: Math.max(0, cap - total),
      });
    }

    if (url.pathname === '/api/founding-member/admin/grant') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);
      if (!(await isAdmin(request, env))) return adminDenied();
      if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
      try {
        const body = await request.json();
        const { memberId, actor, reason } = body;
        if (!memberId) return jsonResponse({ error: 'memberId required' }, 400);
        if (!reason || !reason.trim()) return jsonResponse({ error: 'reason required' }, 400);
        const res = await foundingMemberAdminGrant(env, memberId, actor || 'admin', reason.trim());
        return jsonResponse(res);
      } catch (e) {
        return jsonResponse({ error: String(e && e.message || e) }, 500);
      }
    }

    if (url.pathname === '/api/founding-member/admin/revoke') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);
      if (!(await isAdmin(request, env))) return adminDenied();
      if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
      try {
        const body = await request.json();
        const { memberId, actor, reason } = body;
        if (!memberId) return jsonResponse({ error: 'memberId required' }, 400);
        if (!reason || !reason.trim()) return jsonResponse({ error: 'reason required' }, 400);
        const res = await foundingMemberAdminRevoke(env, memberId, actor || 'admin', reason.trim());
        return jsonResponse(res);
      } catch (e) {
        return jsonResponse({ error: String(e && e.message || e) }, 500);
      }
    }

    if (url.pathname === '/api/founding-member/admin/run-scan') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);
      if (!(await isAdmin(request, env))) return adminDenied();
      if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
      try {
        const result = await foundingMemberRunPromotionScan(env);
        return jsonResponse({ ok: true, ...result });
      } catch (e) {
        return jsonResponse({ error: String(e && e.message || e) }, 500);
      }
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
        // v74e: amendments fields. Default empty array + null pending pointer
        // so the partner UI can render its Amend Booking button decision
        // without first checking field existence.
        if (!Array.isArray(b.amendments)) b.amendments = [];
        if (typeof b.pending_amendment_id === 'undefined') b.pending_amendment_id = null;
        return b;
      }
      if (request.method === 'GET') {
        const ref = url.searchParams.get('ref');
        const slugFilter = url.searchParams.get('slug');
        const emailFilter = url.searchParams.get('email');

        // v75f: partner-facing authorization for ?slug=X queries. Other
        // query shapes (?ref=, ?email=) remain open because hardening them
        // would break customer flows (bookings.html, property.html,
        // nour-el-nil.html) that don't yet use a Clerk-session fetch
        // wrapper. Customer-side hardening lives in v75g.
        // TODO v75g: lock ?ref= to require admin OR booking's partner OR booking's guest
        // TODO v75g: lock ?email= to require admin OR guest with that Clerk-verified email
        const requesterAdmin = await isAdmin();

        // Single booking by ref (NOT YET LOCKED — see TODO)
        if (ref) {
          const raw = await env.DOSSIERS.get('booking:' + ref);
          const data = raw ? backfillBookingShape(JSON.parse(raw)) : null;
          return jsonResponse({ ref, data, exists: !!data });
        }

        if (slugFilter) {
          // Partner-scoped view (LOCKED — partner of slug or admin only)
          if (!requesterAdmin) {
            const requesterId = await getRequesterUserId();
            if (!requesterId) return partnerDenied('not_signed_in');
            if (!(await isPartnerOf(slugFilter, requesterId))) {
              return partnerDenied('not_partner_of_' + slugFilter);
            }
          }
        } else if (emailFilter) {
          // Customer-scoped view (NOT YET LOCKED — see TODO)
        } else {
          // No filter — admin-only bulk list.
          if (!requesterAdmin) return adminDenied();
        }

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
          bookings = bookings.filter(function(b) { return b.slug === slugFilter; });
        }
        if (emailFilter) {
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
                notes, nights, guestId } = body;

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
          // v74v: Clerk user ID, captured from the auth-gated booking flow.
          // Used to link bookings to Reserve Credits ledgers. Falls back to
          // email lookup for older bookings via creditsResolveMemberId.
          guestId: guestId || '',
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

            // v73at: branded email shell used for all three sends.
            const ePropLabel = escapeEmailHtml(property);
            const eGuestFull = escapeEmailHtml((firstname || '') + ' ' + (lastname || ''));
            const eRef = escapeEmailHtml(ref);
            const detailsRowsGuest =
              '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;width:120px;">Property</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + ePropLabel + '</td></tr>'
              + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Dates</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + escapeEmailHtml(arrival) + ' &rarr; ' + escapeEmailHtml(departure) + ' (' + escapeEmailHtml(nights) + ' nights)</td></tr>'
              + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Guests</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + escapeEmailHtml(guests) + '</td></tr>'
              + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Room</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + escapeEmailHtml(room) + '</td></tr>'
              + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Deposit due</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;font-weight:600;">$' + escapeEmailHtml(depositAmount) + '</td></tr>';
            const guestBodyHtml =
              '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
              + '<table cellpadding="0" cellspacing="0" border="0" width="100%">' + detailsRowsGuest + '</table>'
              + '</div>'
              + '<p style="font-size:.9rem;line-height:1.55;color:#3a3128;margin:0 0 6px;">The property will contact you at <strong>' + escapeEmailHtml(email) + '</strong> within 24 hours to confirm your stay.</p>';

            const detailsRowsAdmin =
              '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;width:120px;">Guest</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + eGuestFull + '</td></tr>'
              + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Email</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + escapeEmailHtml(email) + '</td></tr>'
              + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Phone</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + escapeEmailHtml(phone || 'not provided') + '</td></tr>'
              + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Property</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + ePropLabel + '</td></tr>'
              + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Dates</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + escapeEmailHtml(arrival) + ' &rarr; ' + escapeEmailHtml(departure) + ' (' + escapeEmailHtml(nights) + ' nights)</td></tr>'
              + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Guests</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + escapeEmailHtml(guests) + '</td></tr>'
              + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Room</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + escapeEmailHtml(room) + '</td></tr>'
              + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Total / Deposit</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;font-weight:600;">$' + escapeEmailHtml(totalAmount) + ' / $' + escapeEmailHtml(depositAmount) + '</td></tr>'
              + (notes ? '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;vertical-align:top;">Notes</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;white-space:pre-wrap;">' + escapeEmailHtml(notes) + '</td></tr>' : '');
            const adminBodyHtml =
              '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
              + '<table cellpadding="0" cellspacing="0" border="0" width="100%">' + detailsRowsAdmin + '</table>'
              + '</div>';

            await Promise.all([
              sendBrandedEmail({
                env, logTag: 'Booking',
                to: [email],
                subject: 'Booking request received \u2014 ' + ref + ' \u00b7 ' + property,
                text: guestEmailBody,
                shell: {
                  preheader: 'Your booking request for ' + property + ' has been received.',
                  kicker: 'The Bearing',
                  heading: 'Hi ' + escapeEmailHtml(firstname) + ', your booking is in',
                  intro: 'We\u2019ve received your booking request. The property will confirm shortly.',
                  bodyHtml: guestBodyHtml,
                  refLabel: ref,
                  footerNote: 'Questions in the meantime? Reply to this email and we\u2019ll route it to the right team.'
                }
              }),
              sendBrandedEmail({
                env, logTag: 'Booking',
                from: 'The Bearing Bookings <bookings@thebearing.io>',
                to: adminRecipients,
                subject: 'New booking \u2014 ' + ref + ' \u00b7 ' + firstname + ' ' + lastname + ' \u00b7 ' + property,
                text: adminEmailBody,
                shell: {
                  preheader: 'New booking from ' + firstname + ' ' + lastname + ' at ' + property,
                  kicker: 'The Bearing \u00b7 Admin',
                  heading: 'New booking request',
                  intro: '<strong>' + eGuestFull + '</strong> just submitted a booking at ' + ePropLabel + '.',
                  bodyHtml: adminBodyHtml,
                  ctaUrl: 'https://thebearing.io/admin-bookings.html',
                  ctaLabel: 'Open in admin',
                  refLabel: ref
                }
              })
            ]);

            // v73al: notify partner emails for this property (deduped against admin)
            // v73as: gate by shouldSendPartnerEmail('new_enquiry'). No conv
            // object in this path; gate uses per-property settings only.
            if (slug && await shouldSendPartnerEmail('new_enquiry', {}, slug, env)) {
              try {
                const partnerRecipients = await loadPartnerRecipients(slug, env);
                const partnerToSend = partnerRecipients.filter(function(e) {
                  return adminRecipients.indexOf(e) === -1;
                });
                if (partnerToSend.length) {
                  await sendBrandedEmail({
                    env, logTag: 'Booking',
                    from: 'The Bearing Bookings <bookings@thebearing.io>',
                    to: partnerToSend,
                    subject: '[PARTNER] New booking \u2014 ' + ref + ' \u00b7 ' + firstname + ' ' + lastname + ' \u00b7 ' + property,
                    text: adminEmailBody.replace('admin-bookings.html', 'pp-bookings.html'),
                    shell: {
                      preheader: 'New booking from ' + firstname + ' ' + lastname + ' at ' + property,
                      kicker: 'The Bearing \u00b7 Partner',
                      heading: 'New booking request',
                      intro: '<strong>' + eGuestFull + '</strong> just submitted a booking at ' + ePropLabel + '.',
                      bodyHtml: adminBodyHtml,
                      ctaUrl: 'https://thebearing.io/pp-bookings.html',
                      ctaLabel: 'Open in partner portal',
                      refLabel: ref
                    }
                  });
                }
              } catch (e) { console.error('[Booking] partner email error:', e.message); }
            }
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

          // v74v: void any pending/earned Reserve Credits from this booking.
          // Cancellable statuses are enquiry/pending/offer_sent — at those
          // statuses there shouldn't yet be any earn entries (credits only
          // accrue on deposit_paid), but the void call is cheap and defensive.
          // If this booking was Nour El Nil and used a redemption, reverse that too.
          try {
            const credRes = await creditsVoidOnCancellation(env, booking);
            if (credRes && credRes.voided > 0) {
              console.log('[credits] cancelled booking ' + ref + ' voided ' + credRes.voided + ' entries');
            }
            if (credRes && credRes.alreadyUsed > 0) {
              console.warn('[credits] cancelled booking ' + ref + ' had ' + credRes.alreadyUsed + ' already-used entries — admin intervention may be required');
            }
            // Also reverse any redemption applied TO this booking (Nour El Nil case)
            const memberId = await creditsResolveMemberId(env, booking);
            if (memberId) {
              await creditsReverseRedemption(env, memberId, ref).catch(function(_){});
            }
          } catch (e) {
            console.error('[credits] cancellation hook failed:', e && e.message);
          }

          // v74w: void Founding Member status if it was reserved for this
          // booking (and is still pending). Recycles the number. May re-reserve
          // against another confirmed booking if one exists.
          try {
            const fmRes = await foundingMemberVoidIfPendingForBooking(env, booking);
            if (fmRes && fmRes.voidedNumber) {
              console.log('[fm] voided #' + fmRes.voidedNumber + ' on cancel of ' + ref);
            }
          } catch (e) {
            console.error('[fm] void failed on manual cancel:', e && e.message);
          }

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
        // v74v: void any Reserve Credits from this booking, and reverse any
        // redemption applied to this booking.
        try {
          await creditsVoidOnCancellation(env, booking);
          const memberId = await creditsResolveMemberId(env, booking);
          if (memberId) await creditsReverseRedemption(env, memberId, ref).catch(function(_){});
        } catch (e) {
          console.error('[credits] DELETE cancellation hook failed:', e && e.message);
        }
        // v74w: void FM if reserved for this booking
        try { await foundingMemberVoidIfPendingForBooking(env, booking); } catch(e) {}
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
      const counter = counterRaw ? JSON.parse(counterRaw) : { admin: 0, guests: {}, props: {}, adminLoop: 0, propsLoop: {} };

      let unread = 0;
      let loopUnread = 0; // v74b: separate count of conversations with active-loop unread for THIS role
      if (role === 'admin') {
        unread = counter.admin || 0;
        loopUnread = counter.adminLoop || 0;
      } else if (role === 'guest') {
        const guestId = url.searchParams.get('guestId');
        unread = (guestId && counter.guests && counter.guests[guestId]) || 0;
        // Guests never participate in loops, so loopUnread stays 0
      } else if (role === 'partner') {
        const slug = url.searchParams.get('slug');
        unread = (slug && counter.props && counter.props[slug]) || 0;
        loopUnread = (slug && counter.propsLoop && counter.propsLoop[slug]) || 0;
      }
      // v74b: total = main-thread unread + loop unread, rolled into one number
      // for the sidebar. hasLoop is the styling hint — when true, badge gets a
      // terracotta border treatment to signal "private activity is in there."
      const total = unread + loopUnread;
      return jsonResponse({ unread: total, mainUnread: unread, loopUnread, hasLoop: loopUnread > 0 });
    }

    // v73ao: /api/unread-debug — admin-gated diagnostic for the unread badge
    // pipeline. Returns the full aggregated counter + each conversation's
    // contribution to it so you can see exactly which conv is producing
    // (or failing to produce) the count for a given guestId.
    // Use ?guestId=X to filter to that guest's convs; omit to see the full
    // picture. Also exposes a ?force=recompute flag that recomputes from
    // scratch before returning, useful to test if the counter is stale.
    if (url.pathname === '/api/unread-debug') {
      if (!(await isAdmin())) return adminDenied();
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);
      const filterGuestId = url.searchParams.get('guestId');
      if (url.searchParams.get('force') === 'recompute') {
        await recomputeUnreadCounters(env);
      }
      const counterRaw = await env.DOSSIERS.get('__unread_counters');
      const counter = counterRaw ? JSON.parse(counterRaw) : null;
      const idxRaw = await env.DOSSIERS.get('__conversations_index');
      const ids = idxRaw ? JSON.parse(idxRaw) : [];
      const convs = [];
      for (const cid of ids) {
        const cRaw = await env.DOSSIERS.get('conversation:' + cid);
        if (!cRaw) continue;
        const c = JSON.parse(cRaw);
        if (filterGuestId && c.guestId !== filterGuestId) continue;
        convs.push({
          id: c.id, guestId: c.guestId, guestEmail: c.guestEmail,
          propertySlug: c.propertySlug, status: c.status,
          unreadAdmin: c.unreadAdmin || 0, unreadGuest: c.unreadGuest || 0,
          lastMessageAt: c.lastMessageAt
        });
      }
      return jsonResponse({
        counter: counter,
        convs: convs,
        recomputed: url.searchParams.get('force') === 'recompute'
      });
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

        // v75f: partner-facing authorization for ?slug=X queries. Other
        // query shapes (?id=, ?guestId=) currently remain open because
        // hardening them would break customer flows that don't yet use a
        // Clerk-session fetch wrapper. Customer-side hardening lives in
        // v75g (add customer-fetch.js + lock these branches).
        // TODO v75g: lock ?guestId= to require requesterId === guestId
        // TODO v75g: lock ?id= to require admin OR partner OR conv's guest
        const requesterAdmin = await isAdmin();

        // Fetch single conversation with messages (NOT YET LOCKED — see TODO)
        if (id) {
          const raw = await env.DOSSIERS.get('conversation:' + id);
          if (!raw) return jsonResponse({ error: 'not found' }, 404);
          const conv = JSON.parse(raw);
          const msgsRaw = await env.DOSSIERS.get('conversation:' + id + ':messages');
          const messages = msgsRaw ? JSON.parse(msgsRaw) : [];
          return jsonResponse({ conversation: conv, messages });
        }

        // List conversations for a guest (NOT YET LOCKED — see TODO)
        if (guestId) {
          const rawIds = await env.DOSSIERS.get('guest:' + guestId + ':convs');
          const ids = rawIds ? JSON.parse(rawIds) : [];
          const convs = (await Promise.all(ids.map(async i => {
            const r = await env.DOSSIERS.get('conversation:' + i);
            return r ? JSON.parse(r) : null;
          }))).filter(Boolean).reverse();
          return jsonResponse({ conversations: convs });
        }

        // List conversations for a property (LOCKED — partner or admin only)
        if (slug) {
          if (!requesterAdmin) {
            const requesterId = await getRequesterUserId();
            if (!requesterId) return partnerDenied('not_signed_in');
            if (!(await isPartnerOf(slug, requesterId))) {
              return partnerDenied('not_partner_of_' + slug);
            }
          }
          const rawIds = await env.DOSSIERS.get('prop:' + slug + ':convs');
          const ids = rawIds ? JSON.parse(rawIds) : [];
          const convs = (await Promise.all(ids.map(async i => {
            const r = await env.DOSSIERS.get('conversation:' + i);
            return r ? JSON.parse(r) : null;
          }))).filter(Boolean).reverse();
          // v74c: fold loop summary into each item so partner-side conv list
          // can show 🔒 N indicators inline (same treatment as admin side).
          await Promise.all(convs.map(async (c) => {
            try {
              const loopRaw = await env.DOSSIERS.get('conversation:' + c.id + ':loop');
              if (loopRaw) {
                const loop = JSON.parse(loopRaw);
                c.loopSummary = {
                  active: !!loop.active,
                  unreadAdmin: loop.unreadAdmin || 0,
                  unreadPartner: loop.unreadPartner || 0,
                };
              }
            } catch(_) {}
          }));
          return jsonResponse({ conversations: convs });
        }

        // List all conversations (admin only)
        if (!requesterAdmin) return adminDenied();
        const rawIndex = await env.DOSSIERS.get('__conversations_index');
        const ids = rawIndex ? JSON.parse(rawIndex) : [];
        const convs = (await Promise.all(ids.slice(-50).map(async i => {
          const r = await env.DOSSIERS.get('conversation:' + i);
          return r ? JSON.parse(r) : null;
        }))).filter(Boolean).reverse();
        // Enrich each conv with guest avatar (lookup member record) + loop summary.
        // v74c: loopSummary lets the conv-list UI render a 🔒 N indicator next to
        // each conv up-front, so admin can see at a glance which threads have
        // partner-loop activity without having to click into each one. Field is
        // omitted when there's no loop record at all (keeps response lean for
        // the common case).
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
          // v74c: fold loop record into the conv item if one exists
          try {
            const loopRaw = await env.DOSSIERS.get('conversation:' + c.id + ':loop');
            if (loopRaw) {
              const loop = JSON.parse(loopRaw);
              c.loopSummary = {
                active: !!loop.active,
                unreadAdmin: loop.unreadAdmin || 0,
                unreadPartner: loop.unreadPartner || 0,
              };
            }
          } catch(_) {}
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
              // v74v: link booking to Clerk member for Reserve Credits tracking
              guestId: guestId || '',
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

          // v73at: Three emails fire here:
          //   (1) NEW \u2014 guest enquiry confirmation. Fires regardless of
          //       conv.notifyAdmin/notifyGuest since this is a transactional
          //       receipt the guest expects.
          //   (2) Admin alert (gated by conv.notifyAdmin).
          //   (3) Partner alert (gated by shouldSendPartnerEmail).
          if (env.RESEND_API_KEY && firstMessage) {
            try {
              const eGuestName = escapeEmailHtml(guestName || '');
              const eGuestEmail = escapeEmailHtml(guestEmail || '');
              const ePropName = escapeEmailHtml(propertyName || '');
              const eFirstMsg = escapeEmailHtml(firstMessage || '');
              const eGuestLabel = eGuestName || eGuestEmail;
              const replyToken = 'reply+' + id + '@replies.thebearing.io';

              // Build "what you sent" summary rows for the guest confirmation.
              // `enq` was set above in the conv-create flow.
              const _enq = (typeof enquiry === 'object' && enquiry) ? enquiry : {};
              const enqRows = [];
              if (_enq.arrival || _enq.departure) {
                enqRows.push({ k: 'Dates', v: (_enq.arrival || '?') + (_enq.departure ? ' \u2192 ' + _enq.departure : '') });
              }
              if (_enq.guests) enqRows.push({ k: 'Party size', v: String(_enq.guests) });
              if (_enq.cabin)  enqRows.push({ k: 'Room / cabin', v: String(_enq.cabin) });
              const enqRowsHtml = enqRows.map(function(r) {
                return '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;width:120px;">' + escapeEmailHtml(r.k) + '</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + escapeEmailHtml(r.v) + '</td></tr>';
              }).join('');

              // (1) GUEST CONFIRMATION \u2014 always sends.
              const guestSummaryHtml =
                (enqRowsHtml
                  ? '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
                    + '<div style="font-size:.7rem;color:#7a6a58;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">What you sent</div>'
                    + '<table cellpadding="0" cellspacing="0" border="0" width="100%">' + enqRowsHtml + '</table>'
                    + '</div>'
                  : '')
                + '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
                + '<div style="font-size:.7rem;color:#7a6a58;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">Your message</div>'
                + '<div style="white-space:pre-wrap;line-height:1.55;color:#1e1810;font-size:.95rem;">' + eFirstMsg + '</div>'
                + '</div>';

              const guestText =
                'Thanks for reaching out about ' + propertyName + '.\n\n'
                + 'We\'ve passed your enquiry on to the property team \u2014 they will be in touch shortly.\n\n'
                + (enqRows.length ? 'Your enquiry:\n' + enqRows.map(function(r){return '  ' + r.k + ': ' + r.v;}).join('\n') + '\n\n' : '')
                + 'Your message:\n"' + firstMessage + '"\n\n'
                + 'You can reply directly to this email and it will route into your conversation with the property.\n\n'
                + 'View the conversation: https://thebearing.io/conversations.html?id=' + id + '\n\n'
                + '\u2014 The Bearing\nhttps://thebearing.io';

              await sendBrandedEmail({
                env, logTag: 'Conv-Guest',
                to: [guestEmail],
                replyTo: replyToken,
                subject: 'Your Enquiry for ' + propertyName + ' Was Received',
                text: guestText,
                shell: {
                  preheader: 'We\u2019ve passed your enquiry to the ' + propertyName + ' team.',
                  kicker: 'The Bearing',
                  heading: 'Your enquiry was received',
                  intro: 'Thanks ' + (eGuestName || 'for reaching out') + '. We\u2019ve passed your enquiry to <strong>' + ePropName + '</strong> \u2014 the property team will be in touch shortly.',
                  bodyHtml: guestSummaryHtml,
                  ctaUrl: 'https://thebearing.io/conversations.html?id=' + id,
                  ctaLabel: 'View the conversation',
                  footerNote: 'You can reply directly to this email \u2014 your response will land back in your conversation with the property.',
                  refLabel: ref
                }
              });

              // (2) ADMIN ALERT \u2014 gated by conv.notifyAdmin.
              if (conv.notifyAdmin !== false) {
                const unsubUrl = 'https://thebearing.io/api/notify-toggle?id=' + id + '&role=admin';
                const adminRecipients = await loadNotificationRecipients(env);
                const adminMsgBlock =
                  '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
                  + '<div style="font-size:.7rem;color:#7a6a58;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">Their message</div>'
                  + '<div style="white-space:pre-wrap;line-height:1.55;color:#1e1810;font-size:.95rem;">' + eFirstMsg + '</div>'
                  + '</div>';
                await sendBrandedEmail({
                  env, logTag: 'Conv-Admin',
                  to: adminRecipients,
                  subject: 'New enquiry \u2014 ' + propertyName + ' from ' + (guestName || guestEmail),
                  text: 'New enquiry received.\n\nGuest: ' + (guestName || guestEmail) + ' (' + guestEmail + ')\nProperty: ' + propertyName + '\n\nMessage:\n' + firstMessage + '\n\nReply at: https://thebearing.io/admin-conversations.html?id=' + id + '\n\n\u2014\nMute email notifications for this conversation: ' + unsubUrl,
                  shell: {
                    preheader: 'New enquiry at ' + propertyName + ' from ' + (guestName || guestEmail),
                    kicker: 'The Bearing \u00b7 Admin',
                    heading: 'New enquiry at ' + ePropName,
                    intro: 'from <strong>' + eGuestLabel + '</strong> &middot; ' + eGuestEmail,
                    bodyHtml: adminMsgBlock,
                    ctaUrl: 'https://thebearing.io/admin-conversations.html?id=' + id,
                    ctaLabel: 'Open in admin',
                    refLabel: ref,
                    unsubUrl: unsubUrl
                  }
                });
              }

              // (3) PARTNER ALERT \u2014 gated by shouldSendPartnerEmail.
              if (await shouldSendPartnerEmail('new_enquiry', conv, propertySlug, env)) {
                const adminRecipients2 = await loadNotificationRecipients(env);
                const partnerRecipients = await loadPartnerRecipients(propertySlug, env);
                const partnerToSend = partnerRecipients.filter(function(e) {
                  return adminRecipients2.indexOf(e) === -1;
                });
                if (partnerToSend.length) {
                  // v73am: include ?as=slug so partner-portal page knows which
                  // property's conversations to scope to.
                  // v73an: primary CTA is now "Build offer" deep-linking to
                  // pp-bookings with ?newOffer={ref} which auto-opens the
                  // offer-builder modal for that booking. Secondary CTA opens
                  // the conversation.
                  const bookingsUrl = 'https://thebearing.io/pp-bookings.html?as=' + encodeURIComponent(propertySlug) + '&newOffer=' + encodeURIComponent(ref);
                  const convUrl = 'https://thebearing.io/pp-conversations.html?id=' + id + '&as=' + encodeURIComponent(propertySlug);
                  const partnerMsgBlock =
                    '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
                    + '<div style="font-size:.7rem;color:#7a6a58;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">Their message</div>'
                    + '<div style="white-space:pre-wrap;line-height:1.55;color:#1e1810;font-size:.95rem;">' + eFirstMsg + '</div>'
                    + '</div>';
                  await sendBrandedEmail({
                    env, logTag: 'Conv-Partner',
                    to: partnerToSend,
                    replyTo: replyToken,
                    subject: '[PARTNER] New enquiry \u2014 ' + propertyName + ' from ' + (guestName || guestEmail),
                    text: 'New enquiry at ' + propertyName + ' from ' + (guestName || guestEmail) + ' (' + guestEmail + ').\n\nMessage:\n' + firstMessage + '\n\nBuild offer: ' + bookingsUrl + '\nOpen conversation: ' + convUrl + '\n\nOr reply directly to this email \u2014 your response will be sent to the guest.\n\nReference: ' + ref + '\n\n\u2014 The Bearing',
                    shell: {
                      preheader: 'New enquiry at ' + propertyName + ' from ' + (guestName || guestEmail),
                      kicker: 'The Bearing \u00b7 Partner',
                      heading: 'New enquiry at ' + ePropName,
                      intro: 'from <strong>' + eGuestLabel + '</strong> &middot; ' + eGuestEmail,
                      bodyHtml: partnerMsgBlock,
                      ctaUrl: bookingsUrl,
                      ctaLabel: 'Build offer',
                      ctaSecondaryUrl: convUrl,
                      ctaSecondaryLabel: 'Open conversation',
                      footerNote: 'Or reply directly to this email \u2014 your response will be sent to the guest as a partner message in the conversation.',
                      refLabel: ref
                    }
                  });
                }
              }
            } catch(e) { console.error('[Conv] enquiry email block error:', e.message); }
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
                  const eText = escapeEmailHtml(text);
                  const eSender = escapeEmailHtml(displaySender);
                  const ePropName = escapeEmailHtml(conv.propertyName || '');
                  const msgBlock =
                    '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
                    + '<div style="font-size:.7rem;color:#7a6a58;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">From ' + eSender + '</div>'
                    + '<div style="white-space:pre-wrap;line-height:1.55;color:#1e1810;font-size:.95rem;">' + eText + '</div>'
                    + '</div>';
                  await sendBrandedEmail({
                    env, logTag: 'Conv-Reply-Guest',
                    from: conv.propertyName + ' via The Bearing <bookings@thebearing.io>',
                    to: [conv.guestEmail],
                    replyTo: 'reply+' + id + '@replies.thebearing.io',
                    subject: 'New message about your ' + conv.propertyName + ' enquiry',
                    text: displaySender + ' sent you a message on The Bearing:\n\n"' + text + '"\n\nYou can reply to this email or view the conversation here:\n' + replyUrl + '\n\n\u2014 The Bearing\nhttps://thebearing.io\n\n\u2014\nMute email notifications for this conversation: ' + unsubUrl,
                    shell: {
                      preheader: eSender + ' sent you a message about ' + ePropName,
                      kicker: 'The Bearing',
                      heading: 'A message from ' + eSender,
                      intro: 'About your enquiry at <strong>' + ePropName + '</strong>',
                      bodyHtml: msgBlock,
                      ctaUrl: replyUrl,
                      ctaLabel: 'Open conversation',
                      footerNote: 'You can also reply directly to this email \u2014 your response will land in the conversation thread.',
                      unsubUrl: unsubUrl
                    }
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
                  let subject, bodyText, headingHtml, introHtml, changeLinesHtml = '';
                  if (storedChangeRequest && changeRequestSummary) {
                    const fmt = function(s){ try { return new Date(s.length===10?s+'T00:00':s).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); } catch(_){ return s; } };
                    const cr = changeRequestSummary;
                    const prev = cr.previousValues || {};
                    const changeLines = [];
                    if (cr.arrival && cr.departure && (cr.arrival !== prev.arrival || cr.departure !== prev.departure)) {
                      changeLines.push('Dates: ' + (prev.arrival && prev.departure ? (fmt(prev.arrival) + ' \u2192 ' + fmt(prev.departure) + '   \u2192   ') : '') + fmt(cr.arrival) + ' \u2192 ' + fmt(cr.departure));
                    }
                    if (cr.guests && cr.guests !== prev.guests) {
                      changeLines.push('Guests: ' + (prev.guests || '(unset)') + '   \u2192   ' + cr.guests);
                    }
                    if (cr.cabin && cr.cabin !== prev.room) {
                      changeLines.push('Room: ' + (prev.room || '(unset)') + '   \u2192   ' + cr.cabin);
                    }
                    subject = 'Change request from ' + conv.guestName + ' \u2014 ' + conv.propertyName;
                    bodyText = conv.guestName + ' requested a change to the active offer on ' + conv.propertyName + '.\n\n' +
                               (changeLines.length ? changeLines.join('\n') + '\n\n' : '') +
                               'Their message:\n\n"' + text + '"\n\n' +
                               'Action: open the booking in the partner portal, click "Revise offer" \u2014 the form will pre-fill with the requested values.\n\n' +
                               'View conversation: https://thebearing.io/admin-conversations.html?id=' + id + '\n\n' +
                               '\u2014\nMute email notifications for this conversation: ' + unsubUrl;
                    headingHtml = 'Change request from ' + escapeEmailHtml(conv.guestName);
                    introHtml = 'Requested change to the active offer on <strong>' + escapeEmailHtml(conv.propertyName) + '</strong>.';
                    if (changeLines.length) {
                      changeLinesHtml = '<div style="background:#fdf3e7;border:1px solid rgba(176,88,48,.3);border-radius:12px;padding:14px 18px;margin:0 0 14px;">'
                        + '<div style="font-size:.7rem;color:#b05830;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;font-weight:700;">Requested changes</div>'
                        + changeLines.map(function(l){return '<div style="font-size:.92rem;line-height:1.5;color:#1e1810;">' + escapeEmailHtml(l) + '</div>';}).join('')
                        + '</div>';
                    }
                  } else {
                    subject = 'Reply from ' + conv.guestName + ' \u2014 ' + conv.propertyName;
                    bodyText = conv.guestName + ' replied:\n\n"' + text + '"\n\nView conversation: https://thebearing.io/admin-conversations.html?id=' + id + '\n\n\u2014\nMute email notifications for this conversation: ' + unsubUrl;
                    headingHtml = 'Reply from ' + escapeEmailHtml(conv.guestName);
                    introHtml = 'About <strong>' + escapeEmailHtml(conv.propertyName) + '</strong>';
                  }
                  const eGuestText = escapeEmailHtml(text);
                  const adminMsgBlock = changeLinesHtml
                    + '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
                    + '<div style="font-size:.7rem;color:#7a6a58;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">Their message</div>'
                    + '<div style="white-space:pre-wrap;line-height:1.55;color:#1e1810;font-size:.95rem;">' + eGuestText + '</div>'
                    + '</div>';

                  await sendBrandedEmail({
                    env, logTag: 'Conv-Reply-Admin',
                    to: adminRecipients,
                    subject: subject,
                    text: bodyText,
                    shell: {
                      preheader: subject,
                      kicker: 'The Bearing \u00b7 Admin',
                      heading: headingHtml,
                      intro: introHtml,
                      bodyHtml: adminMsgBlock,
                      ctaUrl: 'https://thebearing.io/admin-conversations.html?id=' + id,
                      ctaLabel: 'Open in admin',
                      unsubUrl: unsubUrl
                    }
                  });

                  // v73al: also notify partner for the same event (deduped
                  // against adminRecipients). Same subject + body so partner
                  // sees identical context.
                  // v73as: gate by shouldSendPartnerEmail. Event type branches:
                  // if guest sent a change request (storedChangeRequest), event
                  // is 'change_request'; otherwise plain 'guest_reply'. This lets
                  // partners mute reply chatter while still hearing about
                  // material change requests.
                  const _partnerEvent = storedChangeRequest ? 'change_request' : 'guest_reply';
                  if (conv.propertySlug && await shouldSendPartnerEmail(_partnerEvent, conv, conv.propertySlug, env)) {
                    const partnerRecipients = await loadPartnerRecipients(conv.propertySlug, env);
                    const partnerToSend = partnerRecipients.filter(function(e) {
                      return adminRecipients.indexOf(e) === -1;
                    });
                    if (partnerToSend.length) {
                      // v73am: swap admin-portal link for partner-portal +
                      // append ?as=slug so partner sees the right property's
                      // conversations on click. Also reply_to so direct
                      // email replies route to /api/inbound-email.
                      const asParam = '&as=' + encodeURIComponent(conv.propertySlug);
                      const partnerBodyText = bodyText
                        .replace(/admin-conversations\.html\?id=([^\s\n]+)/g, 'pp-conversations.html?id=$1' + asParam)
                        .replace(/View conversation: /g, 'Reply directly to this email, or open the conversation: ');
                      const partnerConvUrl = 'https://thebearing.io/pp-conversations.html?id=' + id + asParam;
                      await sendBrandedEmail({
                        env, logTag: 'Conv-Reply-Partner',
                        to: partnerToSend,
                        replyTo: 'reply+' + id + '@replies.thebearing.io',
                        subject: '[PARTNER] ' + subject,
                        text: partnerBodyText,
                        shell: {
                          preheader: subject,
                          kicker: 'The Bearing \u00b7 Partner',
                          heading: headingHtml,
                          intro: introHtml,
                          bodyHtml: adminMsgBlock,
                          ctaUrl: partnerConvUrl,
                          ctaLabel: 'Open conversation',
                          footerNote: 'Or reply directly to this email \u2014 your response will be sent to the guest as a partner message.'
                        }
                      });
                    }
                  }
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

    // ── /api/loop ─────────────────────────────────────────────────
    // v74a: partner-to-admin private side-thread on a conversation.
    //
    // Why this exists: partners need a way to ask The Bearing for help
    // on a specific guest conversation (e.g. "guest wants to upgrade,
    // can you process the delta?") without that exchange being visible
    // to the guest. The guest's main thread stays clean; the private
    // thread lives in a separate KV key the customer renderer never
    // queries.
    //
    // KV keys:
    //   conversation:{id}:loop         — { active, requestedAt, resolvedAt?, partnerSlug }
    //   conversation:{id}:loop:messages — JSON array of { id, role, senderName, text, sentAt }
    //
    // Auth model:
    //   GET    — admin (isAdmin) OR partner-trust-by-slug (?slug= matches conv.propertySlug)
    //   POST   — same (partner sends from pp side, admin sends from admin side; body.role indicates which)
    //   PATCH  — admin only (resolve flag)
    //
    // First POST creates the loop record + fires [LOOP-IN] alert email to admin.
    // Subsequent POSTs append messages. Email fires only on the FIRST partner message
    // of an unresolved loop, not on every message — admin is already in the loop after that.
    //
    // The customer-facing /api/conversation GET never returns loop data. Loop data
    // is read exclusively via /api/loop.
    if (url.pathname === '/api/loop') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      // Helper: verify caller is either admin or the property partner for this conv.
      // Returns { ok: true, isAdminCaller: bool } on success, or sends 403.
      async function authLoopAccess(convId, slugClaim) {
        const conv = await (async () => {
          const raw = await env.DOSSIERS.get('conversation:' + convId);
          return raw ? JSON.parse(raw) : null;
        })();
        if (!conv) return { error: 'conversation not found', status: 404 };
        const adminCheck = await isAdmin();
        if (adminCheck) return { ok: true, isAdminCaller: true, conv };
        // Partner check — slug claim must match the conv's property
        if (slugClaim && slugClaim === conv.propertySlug) {
          return { ok: true, isAdminCaller: false, conv };
        }
        return { error: 'not authorized', status: 403 };
      }

      if (request.method === 'GET') {
        const convId = url.searchParams.get('convId');
        const slugClaim = url.searchParams.get('slug') || '';
        if (!convId) return jsonResponse({ error: 'convId required' }, 400);
        const auth = await authLoopAccess(convId, slugClaim);
        if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

        const loopRaw = await env.DOSSIERS.get('conversation:' + convId + ':loop');
        const msgsRaw = await env.DOSSIERS.get('conversation:' + convId + ':loop:messages');
        return jsonResponse({
          loop: loopRaw ? JSON.parse(loopRaw) : null,
          messages: msgsRaw ? JSON.parse(msgsRaw) : []
        });
      }

      if (request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const convId = b.convId;
        const text = (b.text || '').toString().trim();
        const slugClaim = (b.slug || '').toString();
        if (!convId || !text) return jsonResponse({ error: 'convId and text required' }, 400);
        if (text.length > 6000) return jsonResponse({ error: 'message too long' }, 400);

        const auth = await authLoopAccess(convId, slugClaim);
        if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
        const conv = auth.conv;
        const role = auth.isAdminCaller ? 'admin' : 'partner';

        // Load existing loop record (if any)
        const loopKey = 'conversation:' + convId + ':loop';
        const msgsKey = 'conversation:' + convId + ':loop:messages';
        const loopRaw = await env.DOSSIERS.get(loopKey);
        let loop = loopRaw ? JSON.parse(loopRaw) : null;
        const isFirstMessage = !loop;

        const now = new Date().toISOString();
        if (isFirstMessage) {
          // Only partners can initiate. Admin posting into a loop that doesn't
          // exist would be confusing — admin should reply, not initiate.
          if (role !== 'partner') {
            return jsonResponse({ error: 'only partner can initiate a loop' }, 400);
          }
          loop = {
            active: true,
            requestedAt: now,
            resolvedAt: null,
            partnerSlug: conv.propertySlug || '',
            lastMessageAt: now,
            unreadAdmin: 1,
            unreadPartner: 0,
          };
        } else {
          // If loop was resolved, reactivate it on a new message
          if (!loop.active) {
            loop.active = true;
            loop.resolvedAt = null;
            loop.reactivatedAt = now;
          }
          loop.lastMessageAt = now;
          if (role === 'partner') {
            loop.unreadAdmin = (loop.unreadAdmin || 0) + 1;
          } else {
            loop.unreadPartner = (loop.unreadPartner || 0) + 1;
          }
        }

        // Reset the receiving side's unread counter — caller has obviously
        // seen their own composer, so any prior unread for them is now read.
        if (role === 'partner') loop.unreadPartner = 0;
        else loop.unreadAdmin = 0;

        const msgsArrRaw = await env.DOSSIERS.get(msgsKey);
        const messages = msgsArrRaw ? JSON.parse(msgsArrRaw) : [];
        const msg = {
          id: 'loopmsg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          role,
          senderName: role === 'admin' ? 'The Bearing' : (conv.propertyName || 'Partner'),
          text,
          sentAt: now,
        };
        messages.push(msg);

        await env.DOSSIERS.put(loopKey, JSON.stringify(loop));
        await env.DOSSIERS.put(msgsKey, JSON.stringify(messages));

        // Fire [LOOP-IN] email to admin on FIRST partner message of an unresolved
        // loop. Bypasses all notification mute settings — this is urgent and
        // partner-initiated. We don't fire on subsequent partner messages (admin
        // is already in the thread by then) or on admin messages.
        if (isFirstMessage && env.RESEND_API_KEY) {
          try {
            const adminRecipients = await loadNotificationRecipients(env);
            const propName = conv.propertyName || conv.propertySlug || 'a property';
            const guestLabel = conv.guestName || conv.guestEmail || 'the guest';
            const convAdminUrl = 'https://thebearing.io/admin-conversations.html?id=' + convId + '&loop=1';

            // Pull last 3 PUBLIC messages from main thread for context
            const mainMsgsRaw = await env.DOSSIERS.get('conversation:' + convId + ':messages');
            const mainMsgs = mainMsgsRaw ? JSON.parse(mainMsgsRaw) : [];
            const lastFew = mainMsgs.slice(-3).map(function(m) {
              return {
                who: (m.role === 'guest' ? (conv.guestName || 'Guest') :
                      (m.role === 'partner' ? (conv.propertyName || 'Partner') :
                      (m.role === 'admin' ? 'The Bearing' : 'System'))),
                when: m.sentAt || '',
                text: (m.text || '').slice(0, 240),
              };
            });
            const eGuestLabel = escapeEmailHtml(guestLabel);
            const ePropName = escapeEmailHtml(propName);
            const eText = escapeEmailHtml(text);
            const lastFewHtml = lastFew.length
              ? '<div style="margin:0 0 22px;">'
                + '<div style="font-size:.7rem;color:#7a6a58;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">Recent conversation context</div>'
                + lastFew.map(function(m) {
                    return '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.10);border-radius:8px;padding:10px 12px;margin-bottom:6px;">'
                      + '<div style="font-size:.72rem;color:#7a6a58;margin-bottom:3px;">' + escapeEmailHtml(m.who) + '</div>'
                      + '<div style="font-size:.86rem;color:#1e1810;white-space:pre-wrap;line-height:1.5;">' + escapeEmailHtml(m.text) + '</div>'
                      + '</div>';
                  }).join('')
                + '</div>'
              : '';
            const bodyHtml =
              // Urgency stripe at the top of the body card
              '<div style="background:linear-gradient(180deg,#fff8f4 0%,#fdf2ea 100%);border:1px solid rgba(176,88,48,.28);border-left:3px solid #b05830;border-radius:12px;padding:16px 18px;margin:0 0 22px;">'
              + '<div style="font-size:.7rem;color:#b05830;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;font-weight:700;">Partner needs help</div>'
              + '<div style="font-size:.95rem;color:#1e1810;line-height:1.55;white-space:pre-wrap;">' + eText + '</div>'
              + '</div>'
              + lastFewHtml;

            await sendBrandedEmail({
              env, logTag: 'Loop-In',
              to: adminRecipients,
              subject: '[LOOP-IN] ' + propName + ' \u00b7 ' + guestLabel,
              text: 'Partner at ' + propName + ' has requested help on the conversation with ' + guestLabel + '.\n\nPartner\'s note:\n"' + text + '"\n\n' + (lastFew.length ? 'Recent context:\n' + lastFew.map(function(m){return '  [' + m.who + '] ' + m.text;}).join('\n') + '\n\n' : '') + 'Open the conversation: ' + convAdminUrl + '\n\nReply privately to the partner here.\n\n\u2014 The Bearing',
              shell: {
                preheader: 'Partner at ' + propName + ' has requested help.',
                kicker: 'The Bearing \u00b7 Action needed',
                heading: 'Partner needs help',
                intro: '<strong>' + ePropName + '</strong> has requested help on their conversation with <strong>' + eGuestLabel + '</strong>.',
                bodyHtml: bodyHtml,
                ctaUrl: convAdminUrl,
                ctaLabel: 'Open private thread',
                footerNote: 'This loop is private — the guest cannot see anything in this thread.',
              }
            });
          } catch (e) { console.error('[Loop-In] email block error:', e && e.message); }
        }

        // v74b: refresh sidebar counters so admin/partner nav badges reflect
        // the new loop message immediately.
        try { await recomputeUnreadCounters(env); } catch(_) {}

        return jsonResponse({ ok: true, loop, message: msg });
      }

      if (request.method === 'PATCH') {
        const b = await request.json().catch(() => ({}));
        const convId = b.convId;
        if (!convId) return jsonResponse({ error: 'convId required' }, 400);
        const action = b.action || 'resolve'; // default preserves v74a behavior

        const loopKey = 'conversation:' + convId + ':loop';
        const loopRaw = await env.DOSSIERS.get(loopKey);
        if (!loopRaw) return jsonResponse({ error: 'no loop on this conversation' }, 404);
        const loop = JSON.parse(loopRaw);

        if (action === 'resolve') {
          // Admin-only — clears active flag, urgency pill goes away.
          if (!(await isAdmin())) return adminDenied();
          loop.active = false;
          loop.resolvedAt = new Date().toISOString();
          await env.DOSSIERS.put(loopKey, JSON.stringify(loop));
          // Recompute counters so sidebar drops the loop-attention indicator.
          try { await recomputeUnreadCounters(env); } catch(_) {}
          return jsonResponse({ ok: true, loop });
        }

        if (action === 'mark_read') {
          // v74b: reset the caller's unread counter. Either side can call this.
          // Caller identity comes from auth (admin via isAdmin, partner via
          // slug claim matching conv.propertySlug).
          const slugClaim = (b.slug || '').toString();
          const auth = await authLoopAccess(convId, slugClaim);
          if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
          if (auth.isAdminCaller) {
            loop.unreadAdmin = 0;
          } else {
            loop.unreadPartner = 0;
          }
          await env.DOSSIERS.put(loopKey, JSON.stringify(loop));
          try { await recomputeUnreadCounters(env); } catch(_) {}
          return jsonResponse({ ok: true, loop });
        }

        return jsonResponse({ error: 'unknown action: ' + action }, 400);
      }

      return jsonResponse({ error: 'method not allowed' }, 405);
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


    // v73as: partner notification preferences endpoint
    // GET  /api/partner-notif?slug=X  \u2014 returns { universalMute, mutedEvents, perConv? }
    // POST /api/partner-notif         \u2014 body: { slug, universalMute, mutedEvents }
    // POST /api/partner-notif         \u2014 body: { slug, convId, eventMute: {new_enquiry:false} } for per-conv per-event
    // Trust model matches the rest of pp-* (slug-based, since real partner
    // auth isn't built yet \u2014 future Clerk-org work will tighten this).
    if (url.pathname === '/api/partner-notif') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      if (request.method === 'GET') {
        const slug = url.searchParams.get('slug');
        if (!slug) return jsonResponse({ error: 'slug required' }, 400);
        const settings = await loadPartnerNotifSettings(slug, env);
        return jsonResponse({ slug, ...settings, events: PARTNER_NOTIF_EVENTS });
      }

      if (request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const slug = b.slug;
        if (!slug || typeof slug !== 'string') {
          return jsonResponse({ error: 'slug required' }, 400);
        }
        if (slug.startsWith('__') || slug.indexOf(':') !== -1) {
          return jsonResponse({ error: 'invalid slug' }, 400);
        }

        // Branch A: per-conv per-event mute
        // body: { slug, convId, eventMute: { new_enquiry: false, guest_reply: true, ... } }
        if (b.convId && b.eventMute && typeof b.eventMute === 'object') {
          const convRaw = await env.DOSSIERS.get('conversation:' + b.convId);
          if (!convRaw) return jsonResponse({ error: 'conversation not found' }, 404);
          const conv = JSON.parse(convRaw);
          if (conv.propertySlug !== slug) {
            return jsonResponse({ error: 'conversation does not belong to this property' }, 403);
          }
          conv.notifyPartnerEvents = conv.notifyPartnerEvents || {};
          // Whitelist event keys
          for (const k of Object.keys(b.eventMute)) {
            if (PARTNER_NOTIF_EVENTS.indexOf(k) !== -1) {
              conv.notifyPartnerEvents[k] = (b.eventMute[k] === false) ? false : true;
            }
          }
          await env.DOSSIERS.put('conversation:' + b.convId, JSON.stringify(conv));
          return jsonResponse({ ok: true, convId: b.convId, notifyPartnerEvents: conv.notifyPartnerEvents });
        }

        // Branch B: per-property universal settings
        // body: { slug, universalMute, mutedEvents }
        const universalMute = !!b.universalMute;
        const mutedEventsRaw = Array.isArray(b.mutedEvents) ? b.mutedEvents : [];
        const mutedEvents = mutedEventsRaw.filter(function(e) {
          return PARTNER_NOTIF_EVENTS.indexOf(e) !== -1;
        });
        await env.DOSSIERS.put('partner-notif:' + slug, JSON.stringify({
          universalMute, mutedEvents,
          updatedAt: new Date().toISOString()
        }));
        return jsonResponse({ ok: true, slug, universalMute, mutedEvents });
      }

      return jsonResponse({ error: 'GET or POST only' }, 405);
    }


    // ── /api/partner-listing ──────────────────────────────────────────
    // v75b: partner-gated property editor. Mirrors /api/property POST but
    // restricted to a whitelist of editable fields, so partners can update
    // their own listing without admin access — and CANNOT touch
    // commission_pct, slug, type, status, partnerUserIds, or any other
    // operational/admin field.
    //
    // GET  /api/partner-listing?slug=X&userId=Y
    //   Returns ONLY the editable fields for the property (a strict subset
    //   of /api/property). userId required so we can confirm the requester
    //   is in partnerUserIds for this slug.
    // POST /api/partner-listing
    //   Body: { slug, userId, changes: {...editableFields...} }
    //   Validates userId is in partnerUserIds, merges only whitelisted
    //   fields into the stored property, writes it back.
    //
    // Trust model: userId comes from sessionStorage tb_pp_user_cache (written
    // by pp-login when Clerk reports a signed-in user). A determined attacker
    // who knows a partner's Clerk user id could spoof this. That's accepted
    // for v75b — it's good enough to prevent accidental cross-property edits
    // and is compatible with the real Clerk-session auth gate when we build
    // it later (just swap the userId check for a Clerk session.verifyToken).
    const PARTNER_LISTING_EDITABLE_FIELDS = [
      // Public identity / display
      'name', 'tagline', 'type', 'location', 'country', 'region',
      'nearest_airport', 'display_tag',
      // Editorial copy
      'short_pitch', 'long_pitch', 'long_history', 'bearing_edit',
      // Pricing copy (NOT commission_pct — that's admin-only)
      'price_from', 'price_currency', 'pricing_model',
      'season_open', 'min_stay', 'max_group',
      // Stay logistics
      'checkin_time', 'checkout_time', 'children_policy', 'pet_policy',
      'included', 'not_included',
      // Tags and categories
      'tags', 'amenities',
    ];

    if (url.pathname === '/api/partner-listing') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      // v75f: identity is now Clerk-session-verified (not URL-param-trusted).
      // We still accept the `userId` URL/body param for backwards compat and
      // for diagnostic logging, but the authorization decision uses the
      // verified Clerk user id from the session token. If the URL param and
      // the session disagree, the session wins and we log a warning.
      const requesterAdmin = await isAdmin();
      const verifiedUserId = await getRequesterUserId();
      const acl = function(slug, claimedUserId) {
        // Admins can always read/write.
        if (requesterAdmin) return { ok: true, userId: verifiedUserId || claimedUserId || 'admin' };
        // Partners must have a verified session.
        if (!verifiedUserId) return { ok: false, reason: 'not_signed_in' };
        // Optional sanity: log if the URL claims a different user_id than the session
        if (claimedUserId && claimedUserId !== verifiedUserId) {
          console.log('[partner-listing] userId mismatch — url claims', claimedUserId, 'session is', verifiedUserId);
        }
        return { ok: true, userId: verifiedUserId };
      };

      if (request.method === 'GET') {
        const slug = url.searchParams.get('slug');
        const claimedUserId = url.searchParams.get('userId');
        if (!slug) return jsonResponse({ error: 'slug required' }, 400);

        const authz = acl(slug, claimedUserId);
        if (!authz.ok) return partnerDenied(authz.reason);

        const raw = await env.DOSSIERS.get(slug + ':property');
        if (!raw) return jsonResponse({ error: 'property not found' }, 404);
        let data;
        try { data = JSON.parse(raw); }
        catch (e) { return jsonResponse({ error: 'property JSON corrupt' }, 500); }

        // Even with a verified session, the user must be in partnerUserIds
        // for this property (unless admin).
        if (!requesterAdmin) {
          const allowed = Array.isArray(data.partnerUserIds) ? data.partnerUserIds : [];
          if (allowed.indexOf(authz.userId) === -1) {
            return jsonResponse({ error: 'not a partner for this property' }, 403);
          }
        }

        // Strict whitelist — return only editable fields.
        const editable = {};
        for (const field of PARTNER_LISTING_EDITABLE_FIELDS) {
          if (data.hasOwnProperty(field)) editable[field] = data[field];
        }
        return jsonResponse({ ok: true, slug, fields: editable });
      }

      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); }
        catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }

        const slug = body.slug;
        const claimedUserId = body.userId;
        const changes = body.changes || {};
        if (!slug || typeof slug !== 'string') {
          return jsonResponse({ error: 'slug required' }, 400);
        }

        const authz = acl(slug, claimedUserId);
        if (!authz.ok) return partnerDenied(authz.reason);

        const raw = await env.DOSSIERS.get(slug + ':property');
        if (!raw) return jsonResponse({ error: 'property not found' }, 404);
        let data;
        try { data = JSON.parse(raw); }
        catch (e) { return jsonResponse({ error: 'property JSON corrupt' }, 500); }

        if (!requesterAdmin) {
          const allowed = Array.isArray(data.partnerUserIds) ? data.partnerUserIds : [];
          if (allowed.indexOf(authz.userId) === -1) {
            return jsonResponse({ error: 'not a partner for this property' }, 403);
          }
        }

        // Merge only whitelisted fields. Anything else in `changes` is
        // silently ignored — by design, so partner UIs can't accidentally
        // strip admin-only fields by sending a partial property object.
        const applied = {};
        const rejected = [];
        for (const key of Object.keys(changes)) {
          if (PARTNER_LISTING_EDITABLE_FIELDS.indexOf(key) === -1) {
            rejected.push(key);
            continue;
          }
          // Lightweight type sanity for the array fields. Strings, numbers,
          // and selects pass through untouched.
          const value = changes[key];
          if (key === 'tags' || key === 'amenities' || key === 'included' || key === 'not_included') {
            // Accept arrays OR comma-separated strings (client convenience)
            if (Array.isArray(value)) {
              data[key] = value;
            } else if (typeof value === 'string') {
              data[key] = value;
            } else {
              rejected.push(key);
              continue;
            }
          } else {
            data[key] = value;
          }
          applied[key] = data[key];
        }

        data.updatedAt = new Date().toISOString();
        data.updatedBy = (requesterAdmin ? 'admin:' : 'partner:') + authz.userId;
        await env.DOSSIERS.put(slug + ':property', JSON.stringify(data));
        console.log('[partner-listing] ' + authz.userId + ' updated ' + slug + ': ' + Object.keys(applied).join(', '));
        return jsonResponse({ ok: true, slug, applied, rejected });
      }

      return jsonResponse({ error: 'GET or POST only' }, 405);
    }


    // ── /api/inbound-email ────────────────────────────────────────
    // Resend inbound webhook. Routes guest+partner email replies back into
    // the conversation thread via the reply+{convId}@replies.thebearing.io
    // token. Bug-fix v74b: this route declaration was missing in v73as
    // through v74a, causing every Cloudflare Pages build since v73at to
    // fail silently at the esbuild step. The handler body was sitting in
    // the source orphaned (esbuild rejected it; Node accepted it which is
    // why local `node -c` checks all passed). Added back here.
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

      // Save message — disambiguate sender as partner vs guest based on the
      // From address (v73am). If from-email matches one of the property's
      // partner_emails (or the transition default fallback), classify as
      // partner; otherwise default to guest. This is the symmetric of v73al's
      // outbound flow: partner gets [PARTNER] emails with reply_to that comes
      // back here, and we need to mark those replies as `role: 'partner'` so
      // they appear correctly in the conversation thread.
      const msgsRaw = await env.DOSSIERS.get('conversation:' + convId + ':messages');
      const messages = msgsRaw ? JSON.parse(msgsRaw) : [];
      const now = new Date().toISOString();
      const fromAddrRaw = body.from || (body.data && body.data.from) || '';
      // Extract bare email address from formats like '"Name" <a@b.com>' or 'a@b.com'
      const fromEmailMatch = String(fromAddrRaw).match(/<([^>]+)>/) || String(fromAddrRaw).match(/([^\s<>"']+@[^\s<>"']+)/);
      const fromEmail = (fromEmailMatch ? fromEmailMatch[1] : '').toLowerCase().trim();

      let inferredRole = 'guest';
      let inferredSenderName = conv.guestName || fromAddrRaw || 'Guest';
      try {
        const partnerListRaw = await loadPartnerRecipients(conv.propertySlug || '', env);
        // v73an: defensive lowercase on both sides. loadPartnerRecipients already
        // lowercases the property's stored emails, but the transition default
        // was capitalized pre-v73an. Lowercase here ensures the indexOf check
        // works regardless of casing in the stored data.
        const partnerList = partnerListRaw.map(function(e) { return String(e || '').toLowerCase().trim(); });
        if (fromEmail && partnerList.indexOf(fromEmail) !== -1) {
          inferredRole = 'partner';
          // Use property name as sender label so the conversation thread reads
          // "Property Name replied" rather than the raw partner email.
          inferredSenderName = conv.propertyName || fromAddrRaw || 'Property';
          console.log('[Inbound] classified as partner reply: ' + fromEmail + ' is in partner_emails for ' + conv.propertySlug);
        } else {
          // Log misses so misconfigured partner_emails are findable in CF logs.
          // Format makes it obvious whether the from-email or the list was empty.
          console.log('[Inbound] classified as guest reply. fromEmail=' + (fromEmail || '(empty)') + ' partnerList=[' + partnerList.join(',') + '] slug=' + (conv.propertySlug || '(none)'));
        }
      } catch (e) {
        console.error('[Inbound] partner-email check failed:', e && e.message);
      }

      const msg = {
        id: 'msg_' + Date.now(),
        role: inferredRole,
        text,
        senderName: inferredSenderName,
        sentAt: now,
        readAt: null,
        source: 'email'
      };
      messages.push(msg);

      conv.lastMessageAt = now;
      conv.lastMessagePreview = text.substring(0, 100);
      // v73am: bump the right unread counter based on inferred role. Partner
      // replies bump unreadGuest + unreadAdmin (both should know about it).
      // Guest replies bump unreadAdmin + unreadPartner (existing behavior had
      // only unreadAdmin, which v73al partner-portal badge logic also reads).
      if (inferredRole === 'partner') {
        conv.unreadGuest = (conv.unreadGuest || 0) + 1;
        conv.unreadAdmin = (conv.unreadAdmin || 0) + 1;
      } else {
        conv.unreadAdmin = (conv.unreadAdmin || 0) + 1;
      }

      // v73ao: diagnostic log so we can trace why a partner email reply isn't
      // triggering the customer's unread badge. Logs: convId, inferred role,
      // guestId on conv (must match Clerk user.id for badge to find it), and
      // both unread fields after the increment.
      console.log('[Inbound] post-bump conv state: convId=' + convId
        + ' inferredRole=' + inferredRole
        + ' guestId=' + (conv.guestId || '(missing)')
        + ' unreadGuest=' + (conv.unreadGuest || 0)
        + ' unreadAdmin=' + (conv.unreadAdmin || 0)
        + ' status=' + (conv.status || '(missing)'));

      await env.DOSSIERS.put('conversation:' + convId, JSON.stringify(conv));
      await env.DOSSIERS.put('conversation:' + convId + ':messages', JSON.stringify(messages));
      await recomputeUnreadCounters(env);

      // v73ao: log the resulting counter state for this guest so we can confirm
      // recompute actually wrote the increment. If the counter for this guest
      // shows 0 here but unreadGuest is 1 above, there's a KV consistency lag
      // or recompute bug. If both show 1 here, the issue is on the client side.
      try {
        const debugCounterRaw = await env.DOSSIERS.get('__unread_counters');
        const debugCounter = debugCounterRaw ? JSON.parse(debugCounterRaw) : null;
        const guestCount = (debugCounter && debugCounter.guests && conv.guestId) ? (debugCounter.guests[conv.guestId] || 0) : 0;
        console.log('[Inbound] post-recompute counter: guests[' + (conv.guestId || '(missing)') + ']=' + guestCount + ' admin=' + ((debugCounter && debugCounter.admin) || 0));
      } catch(e) { console.error('[Inbound] counter readback failed:', e.message); }

      // Record guest's lastreply timestamp for presence
      const nowMs = Date.now();
      const guestKey = conv.guestId || conv.guestEmail;
      if (guestKey) {
        await env.DOSSIERS.put('lastreply:guest:' + guestKey, String(nowMs), { expirationTtl: 2592000 });
      }

      // Notify the right recipients based on who actually sent this email reply.
      // v73am: branch on inferredRole. If partner replied via email, the
      // *customer* needs to know (their conversation has a new partner message).
      // If guest replied (existing path), admin + partner need to know.
      if (env.RESEND_API_KEY) {
        try {
          const adminRecipients = await loadNotificationRecipients(env);
          const ePropName = escapeEmailHtml(conv.propertyName || '');
          const eText = escapeEmailHtml(text);
          if (inferredRole === 'partner') {
            // Partner replied via email → notify the guest as if it came
            // through the portal. Mirrors the customer notification path
            // (envoy.js around line 2068 in the conversation message handler).
            if (conv.notifyGuest !== false && conv.guestEmail) {
              const replyUrl = 'https://thebearing.io/conversations.html?id=' + convId;
              const unsubUrl = 'https://thebearing.io/api/notify-toggle?id=' + convId + '&role=guest';
              const eSender = escapeEmailHtml(inferredSenderName);
              const msgBlock =
                '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
                + '<div style="font-size:.7rem;color:#7a6a58;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">From ' + eSender + '</div>'
                + '<div style="white-space:pre-wrap;line-height:1.55;color:#1e1810;font-size:.95rem;">' + eText + '</div>'
                + '</div>';
              await sendBrandedEmail({
                env, logTag: 'Inbound-Guest',
                from: conv.propertyName + ' via The Bearing <bookings@thebearing.io>',
                to: [conv.guestEmail],
                replyTo: 'reply+' + convId + '@replies.thebearing.io',
                subject: 'New message about your ' + conv.propertyName + ' enquiry',
                text: inferredSenderName + ' sent you a message on The Bearing:\n\n"' + text + '"\n\nYou can reply to this email or view the conversation here:\n' + replyUrl + '\n\n\u2014 The Bearing\nhttps://thebearing.io\n\n\u2014\nMute email notifications for this conversation: ' + unsubUrl,
                shell: {
                  preheader: eSender + ' sent you a message about ' + ePropName,
                  kicker: 'The Bearing',
                  heading: 'A message from ' + eSender,
                  intro: 'About your enquiry at <strong>' + ePropName + '</strong>',
                  bodyHtml: msgBlock,
                  ctaUrl: replyUrl,
                  ctaLabel: 'Open conversation',
                  footerNote: 'You can also reply directly to this email \u2014 your response will land in the conversation thread.',
                  unsubUrl: unsubUrl
                }
              });
            }
            // Also CC admin so they have visibility into partner replies
            if (conv.notifyAdmin !== false && adminRecipients.length) {
              const adminMsgBlock =
                '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
                + '<div style="font-size:.7rem;color:#7a6a58;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">From ' + escapeEmailHtml(inferredSenderName) + ' (partner)</div>'
                + '<div style="white-space:pre-wrap;line-height:1.55;color:#1e1810;font-size:.95rem;">' + eText + '</div>'
                + '</div>';
              await sendBrandedEmail({
                env, logTag: 'Inbound-Admin-FYI',
                to: adminRecipients,
                subject: '[FYI] Partner reply via email \u2014 ' + conv.propertyName,
                text: inferredSenderName + ' (partner) replied via email:\n\n"' + text + '"\n\nView conversation: https://thebearing.io/admin-conversations.html?id=' + convId + '\n\n\u2014 The Bearing',
                shell: {
                  preheader: 'Partner replied via email \u2014 ' + ePropName,
                  kicker: 'The Bearing \u00b7 Admin',
                  heading: 'Partner replied via email',
                  intro: 'At <strong>' + ePropName + '</strong>',
                  bodyHtml: adminMsgBlock,
                  ctaUrl: 'https://thebearing.io/admin-conversations.html?id=' + convId,
                  ctaLabel: 'Open in admin'
                }
              });
            }
          } else if (conv.notifyAdmin !== false) {
            // Guest replied via email \u2014 original flow: notify admin + partner
            const unsubUrl = 'https://thebearing.io/api/notify-toggle?id=' + convId + '&role=admin';
            const eGuestName = escapeEmailHtml(conv.guestName || '');
            const guestMsgBlock =
              '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
              + '<div style="font-size:.7rem;color:#7a6a58;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">From ' + eGuestName + '</div>'
              + '<div style="white-space:pre-wrap;line-height:1.55;color:#1e1810;font-size:.95rem;">' + eText + '</div>'
              + '</div>';
            await sendBrandedEmail({
              env, logTag: 'Inbound-Admin',
              to: adminRecipients,
              subject: 'Email reply from ' + conv.guestName + ' \u2014 ' + conv.propertyName,
              text: conv.guestName + ' replied via email:\n\n"' + text + '"\n\nView conversation: https://thebearing.io/admin-conversations.html?id=' + convId + '\n\n\u2014\nMute email notifications for this conversation: ' + unsubUrl,
              shell: {
                preheader: 'Email reply from ' + eGuestName + ' on ' + ePropName,
                kicker: 'The Bearing \u00b7 Admin',
                heading: 'Email reply from ' + eGuestName,
                intro: 'About <strong>' + ePropName + '</strong>',
                bodyHtml: guestMsgBlock,
                ctaUrl: 'https://thebearing.io/admin-conversations.html?id=' + convId,
                ctaLabel: 'Open in admin',
                unsubUrl: unsubUrl
              }
            });
            // v73al: notify partner too
            // v73as: gate by shouldSendPartnerEmail('guest_reply')
            if (conv.propertySlug && await shouldSendPartnerEmail('guest_reply', conv, conv.propertySlug, env)) {
              const partnerRecipients = await loadPartnerRecipients(conv.propertySlug, env);
              const partnerToSend = partnerRecipients.filter(function(e) {
                return adminRecipients.indexOf(e) === -1;
              });
              if (partnerToSend.length) {
                const ppUrl = 'https://thebearing.io/pp-conversations.html?id=' + convId + '&as=' + encodeURIComponent(conv.propertySlug);
                await sendBrandedEmail({
                  env, logTag: 'Inbound-Partner',
                  to: partnerToSend,
                  replyTo: 'reply+' + convId + '@replies.thebearing.io',
                  subject: '[PARTNER] Email reply from ' + conv.guestName + ' \u2014 ' + conv.propertyName,
                  text: conv.guestName + ' replied via email:\n\n"' + text + '"\n\nReply directly to this email, or open the conversation: ' + ppUrl + '\n\n\u2014 The Bearing',
                  shell: {
                    preheader: 'Email reply from ' + eGuestName + ' on ' + ePropName,
                    kicker: 'The Bearing \u00b7 Partner',
                    heading: 'Email reply from ' + eGuestName,
                    intro: 'About <strong>' + ePropName + '</strong>',
                    bodyHtml: guestMsgBlock,
                    ctaUrl: ppUrl,
                    ctaLabel: 'Open conversation',
                    footerNote: 'Or reply directly to this email \u2014 your response will be sent to the guest as a partner message.'
                  }
                });
              }
            }
          }
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
        // v73at: test email still uses raw fetch because the admin-settings UI
        // surfaces resp.status + resendId for diagnostics. Body gets the branded
        // shell treatment but we don't go through sendBrandedEmail here.
        const testHtml = renderEmailShell({
          preheader: 'Test email from The Bearing admin.',
          kicker: 'The Bearing \u00b7 Admin',
          heading: 'Test email',
          intro: 'This is a diagnostic test email triggered from admin-settings.',
          bodyHtml: '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
            + '<div style="font-size:.85rem;color:#3a3128;line-height:1.6;">If you can read this, your Resend integration is delivering successfully to the configured recipients.</div>'
            + '<div style="font-size:.78rem;color:#7a6a58;margin-top:14px;">Timestamp: ' + escapeEmailHtml(now) + '</div>'
            + '<div style="font-size:.78rem;color:#7a6a58;margin-top:4px;">Recipients: ' + escapeEmailHtml(recipients.join(', ')) + '</div>'
            + '</div>'
        });
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
            html: testHtml,
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
          // v73ai: sync the offer's trip details onto the booking. This is
          // the canonical place to do it \u2014 once an offer is sent, those
          // values supersede whatever was on the booking from the original
          // enquiry. Critical when the customer enquired WITHOUT specifying
          // dates: the booking record still had arrival='' until now.
          // Without this sync, the booking would remain dateless forever
          // even after payment, and partner-side views would show "Dates TBD".
          // Only copy fields the offer has values for (don't blank out
          // booking fields if offer omitted something).
          if (offer.arrival)   booking.arrival   = offer.arrival;
          if (offer.departure) booking.departure = offer.departure;
          if (offer.nights)    booking.nights    = offer.nights;
          if (offer.guests)    booking.guests    = offer.guests;
          if (offer.room)      booking.room      = offer.room;
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
            // v73ai: sync offer trip details onto booking (see same logic in
            // the POST send-immediately path). Critical for enquiries that
            // were submitted without dates \u2014 the booking record needs to
            // reflect the offer's dates once partner sends.
            if (offer.arrival)   booking.arrival   = offer.arrival;
            if (offer.departure) booking.departure = offer.departure;
            if (offer.nights)    booking.nights    = offer.nights;
            if (offer.guests)    booking.guests    = offer.guests;
            if (offer.room)      booking.room      = offer.room;
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
              const ePropName = escapeEmailHtml(bookingDecline.property || bookingDecline.slug);
              const eGuestEmail = escapeEmailHtml(bookingDecline.email || 'unknown');
              const eRef = escapeEmailHtml(bookingDecline.ref);
              const declineDetailsHtml =
                '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
                + '<table cellpadding="0" cellspacing="0" border="0" width="100%">'
                + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;width:120px;">Property</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + ePropName + '</td></tr>'
                + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Guest</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + eGuestEmail + '</td></tr>'
                + (offer.declined_reason ? '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;vertical-align:top;">Reason</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;white-space:pre-wrap;">' + escapeEmailHtml(offer.declined_reason) + '</td></tr>' : '')
                + '</table></div>';
              if (adminRecipients.length) {
                await sendBrandedEmail({
                  env, logTag: 'Offer-Decline-Admin',
                  to: adminRecipients,
                  subject: '[DECLINED] ' + (bookingDecline.property || bookingDecline.slug) + ' \u00b7 ' + bookingDecline.ref,
                  text: 'Offer declined for ' + (bookingDecline.property || bookingDecline.slug) + ' (' + bookingDecline.ref + ').\n\nGuest: ' + (bookingDecline.email || 'unknown') + (offer.declined_reason ? '\nReason: ' + offer.declined_reason : '') + '\n\nThe booking is now back to "enquiry" \u2014 partner can build a fresh offer.\n\nView: https://thebearing.io/admin-bookings.html',
                  shell: {
                    preheader: 'Guest declined the offer for ' + (bookingDecline.property || bookingDecline.slug),
                    kicker: 'The Bearing \u00b7 Admin',
                    heading: 'Offer declined',
                    intro: 'The booking is back to <code style="background:rgba(80,55,25,.08);padding:2px 6px;border-radius:4px;font-size:.85em;">enquiry</code> \u2014 partner can build a fresh offer.',
                    bodyHtml: declineDetailsHtml,
                    ctaUrl: 'https://thebearing.io/admin-bookings.html',
                    ctaLabel: 'Open in admin',
                    refLabel: bookingDecline.ref
                  }
                });
              }
              // v73al: notify partner too
              // v73as: gate by shouldSendPartnerEmail('offer_declined'). Need
              // to load conv to honor per-thread mute settings; fall through
              // to settings-only check if no conversationId.
              const slug = bookingDecline.slug || bookingDecline.propertySlug;
              let _declineConv = null;
              if (bookingDecline.conversationId) {
                try {
                  const _cr = await env.DOSSIERS.get('conversation:' + bookingDecline.conversationId);
                  if (_cr) _declineConv = JSON.parse(_cr);
                } catch(_) {}
              }
              if (slug && await shouldSendPartnerEmail('offer_declined', _declineConv || {}, slug, env)) {
                const partnerRecipients = await loadPartnerRecipients(slug, env);
                const partnerToSend = partnerRecipients.filter(function(e) {
                  return adminRecipients.indexOf(e) === -1;
                });
                if (partnerToSend.length) {
                  // v73am: reply_to so partner replies route to inbound webhook,
                  // plus a partner-portal link with ?as= so they can review the
                  // booking. Only attached if we have a conversationId.
                  const ppConvUrl = bookingDecline.conversationId
                    ? 'https://thebearing.io/pp-conversations.html?id=' + encodeURIComponent(bookingDecline.conversationId) + '&as=' + encodeURIComponent(slug)
                    : '';
                  await sendBrandedEmail({
                    env, logTag: 'Offer-Decline-Partner',
                    to: partnerToSend,
                    replyTo: bookingDecline.conversationId ? 'reply+' + bookingDecline.conversationId + '@replies.thebearing.io' : undefined,
                    subject: '[PARTNER] Offer declined \u00b7 ' + (bookingDecline.property || bookingDecline.slug) + ' \u00b7 ' + bookingDecline.ref,
                    text: 'Your offer for ' + (bookingDecline.property || bookingDecline.slug) + ' was declined.\n\nGuest: ' + (bookingDecline.email || 'unknown') + (offer.declined_reason ? '\nReason: ' + offer.declined_reason : '') + '\n\nThe booking is back to "enquiry". Build a revised offer in the partner portal.\n\n' + (ppConvUrl ? 'Open the conversation: ' + ppConvUrl + '\n\n' : '') + '\u2014 The Bearing',
                    shell: {
                      preheader: 'Your offer for ' + (bookingDecline.property || bookingDecline.slug) + ' was declined',
                      kicker: 'The Bearing \u00b7 Partner',
                      heading: 'Offer declined by guest',
                      intro: 'Your offer for <strong>' + ePropName + '</strong> was declined. The booking is back to <code style="background:rgba(80,55,25,.08);padding:2px 6px;border-radius:4px;font-size:.85em;">enquiry</code> \u2014 build a revised offer.',
                      bodyHtml: declineDetailsHtml,
                      ctaUrl: ppConvUrl,
                      ctaLabel: ppConvUrl ? 'Open conversation' : '',
                      refLabel: bookingDecline.ref
                    }
                  });
                }
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

    // ── /api/amendment ────────────────────────────────────────────
    // v74e: Booking Amendments — Build 1 (data model + UI, no Stripe yet).
    //
    // POST body: { bookingRef, partner_note, [new fields: room, arrival, departure,
    //              guests, total_amount] } — creates an amendment offer for a
    //              deposit-paid booking. Computes delta vs booking's current
    //              state, auto-detects amendment_kind, posts amendment_card
    //              system message in the linked conversation, emails guest.
    //
    // PATCH body: { offerId, action: 'approve' | 'decline', requesterEmail }
    //              — guest accepts or declines the amendment. Approve (Build 1
    //              stub): marks amendment accepted, original offer flips to
    //              superseded_by_amendment, booking record updates atomically,
    //              admin+partner notified by email with a manual-invoice line.
    //              Real Stripe delta-charge wiring lands in Build 2.
    //
    // Trust model:
    // - POST: partner-trust by slug (matches existing pp-* convention) OR admin
    // - PATCH: ownership-by-email check against booking.email (matches the
    //          /api/checkout/create-session and /api/offer guest-decline patterns)
    if (url.pathname === '/api/amendment') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      // Shared: post amendment_card / amendment_accepted / amendment_declined
      // into the conversation linked to the booking. Mirrors the v73j
      // postOfferCardToConversation pattern.
      async function postAmendmentCardToConversation(amendment, booking, kind) {
        // kind: 'amendment_card' | 'amendment_accepted' | 'amendment_declined'
        try {
          const convId = booking && booking.conversationId;
          if (!convId) return;
          const convRaw = await env.DOSSIERS.get('conversation:' + convId);
          if (!convRaw) return;
          const conv = JSON.parse(convRaw);
          const msgsRaw = await env.DOSSIERS.get('conversation:' + convId + ':messages');
          const messages = msgsRaw ? JSON.parse(msgsRaw) : [];
          const cardTs = new Date().toISOString();

          const baseSummary = {
            propertyName: amendment.propertyName || '',
            room: amendment.room || '',
            arrival: amendment.arrival || '',
            departure: amendment.departure || '',
            guests: amendment.guests || 0,
            total_amount: amendment.total_amount || 0,
            deposit_amount: amendment.deposit_amount || 0,
            delta_total: amendment.delta_total || 0,
            delta_deposit: amendment.delta_deposit || 0,
            amendment_kind: amendment.amendment_kind || 'mixed',
            previous_state: amendment.previous_state || null,
            currency: amendment.currency || 'USD',
          };

          let card;
          let preview;
          if (kind === 'amendment_card') {
            card = {
              id: 'msg_' + Date.now() + '_amcard',
              role: 'partner',
              type: 'amendment_card',
              amendmentId: amendment.id,
              bookingRef: booking.ref,
              amendmentSummary: baseSummary,
              partner_note: amendment.partner_note || '',
              text: 'A change to your booking has been proposed \u2014 open your conversation to review.',
              // v74k: renderer reads `sentAt` (not `timestamp`). The v74j
              // code wrote only `timestamp` which produced "Invalid Date"
              // on screen because `new Date(undefined).toLocaleTimeString()`
              // returns "Invalid Date".
              sentAt: cardTs,
              timestamp: cardTs,
            };
            preview = '\u270e Booking change proposed \u00b7 ' + (amendment.propertyName || 'Property');
            // Guest needs to see this
            conv.unreadGuest = (conv.unreadGuest || 0) + 1;
          } else if (kind === 'amendment_accepted') {
            card = {
              id: 'msg_' + Date.now() + '_amok',
              role: 'system',
              type: 'amendment_accepted',
              amendmentId: amendment.id,
              bookingRef: booking.ref,
              amendmentSummary: baseSummary,
              text: 'Your booking has been updated.',
              sentAt: cardTs,
              timestamp: cardTs,
            };
            preview = '\u2713 Booking updated \u00b7 ' + (amendment.propertyName || 'Property');
            // Both partner and admin want to know
            conv.unreadAdmin = (conv.unreadAdmin || 0) + 1;
          } else if (kind === 'amendment_declined') {
            card = {
              id: 'msg_' + Date.now() + '_amno',
              role: 'system',
              type: 'amendment_declined',
              amendmentId: amendment.id,
              bookingRef: booking.ref,
              amendmentSummary: baseSummary,
              text: 'The proposed change was declined. Your original booking stands.',
              sentAt: cardTs,
              timestamp: cardTs,
            };
            preview = '\u00d7 Change declined \u00b7 ' + (amendment.propertyName || 'Property');
            conv.unreadAdmin = (conv.unreadAdmin || 0) + 1;
          } else {
            return;
          }

          messages.push(card);
          conv.lastMessageAt = cardTs;
          conv.lastMessagePreview = preview;
          await env.DOSSIERS.put('conversation:' + convId, JSON.stringify(conv));
          await env.DOSSIERS.put('conversation:' + convId + ':messages', JSON.stringify(messages));
          if (typeof recomputeUnreadCounters === 'function') {
            await recomputeUnreadCounters(env);
          }
        } catch (e) {
          console.error('[Amendment card] failed:', e && e.stack || e);
        }
      }

      // ─ POST ─ Partner creates amendment
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); }
        catch(_) { return jsonResponse({ error: 'invalid JSON' }, 400); }

        const { bookingRef, room, arrival, departure, guests, total_amount, partner_note } = body;
        if (!bookingRef) return jsonResponse({ error: 'bookingRef required' }, 400);
        if (typeof total_amount !== 'number' || total_amount <= 0) {
          return jsonResponse({ error: 'total_amount must be a positive number' }, 400);
        }

        // Load booking
        const bookingRaw = await env.DOSSIERS.get('booking:' + bookingRef);
        if (!bookingRaw) return jsonResponse({ error: 'booking not found: ' + bookingRef }, 404);
        const booking = JSON.parse(bookingRaw);

        // Trust model: admin OR partner-by-slug matching booking.slug
        // v74f: bookings store the property slug as `slug` (not `propertySlug`).
        // The check was comparing against `propertySlug` which is undefined on
        // every booking, so slugMatches was always false — every partner POST
        // was 403'd. Also accept `propertySlug` as a fallback for any future
        // records that might use that field instead.
        const slugClaim = (body.slug || '').toString();
        const isAdminCaller = await isAdmin();
        const bookingSlug = booking.slug || booking.propertySlug || '';
        const slugMatches = slugClaim && bookingSlug && (slugClaim === bookingSlug);
        if (!isAdminCaller && !slugMatches) {
          return jsonResponse({ error: 'not authorized to amend this booking' }, 403);
        }

        // Spec answer Q1: deposit_paid required. No amending unpaid bookings.
        if (booking.paymentStatus !== 'deposit_paid') {
          return jsonResponse({ error: 'booking is not paid \u2014 amendments are only for deposit_paid bookings' }, 400);
        }
        if (booking.status === 'cancelled') {
          return jsonResponse({ error: 'booking is cancelled' }, 400);
        }

        // Compute previous_state from current booking values.
        // v74g: confirmed bookings store totals as `confirmed_total_amount`
        // (Stripe webhook sets these). Fall through to `total_amount` for
        // backward compat with any legacy records.
        const previous_state = {
          room: booking.room || '',
          arrival: booking.arrival || '',
          departure: booking.departure || '',
          guests: booking.guests || 0,
          total_amount: booking.confirmed_total_amount || booking.total_amount || booking.totalAmount || 0,
          deposit_amount: booking.depositPaidAmount || booking.confirmed_deposit_amount || booking.deposit_amount || booking.depositAmount || 0,
        };

        // Auto-detect amendment_kind based on what changed
        const changed = {
          room: (room || '') !== previous_state.room,
          arrival: (arrival || '') !== previous_state.arrival,
          departure: (departure || '') !== previous_state.departure,
          guests: (guests || 0) !== previous_state.guests,
        };
        const datesChanged = changed.arrival || changed.departure;
        let amendment_kind;
        if (datesChanged && !changed.room && !changed.guests) {
          // Same room, different dates \u2014 could be date_change or duration_change
          // Compute nights diff
          const oldNights = (new Date(previous_state.departure) - new Date(previous_state.arrival)) / 86400000;
          const newNights = (new Date(departure) - new Date(arrival)) / 86400000;
          amendment_kind = (oldNights !== newNights) ? 'duration_change' : 'date_change';
        } else if (!datesChanged && !changed.room && changed.guests) {
          amendment_kind = 'party_change';
        } else if (!datesChanged && changed.room && !changed.guests) {
          amendment_kind = total_amount > previous_state.total_amount ? 'upgrade' : 'downgrade';
        } else if (total_amount > previous_state.total_amount) {
          amendment_kind = 'upgrade';
        } else if (total_amount < previous_state.total_amount) {
          amendment_kind = 'downgrade';
        } else {
          amendment_kind = 'mixed';
        }

        const delta_total = total_amount - previous_state.total_amount;

        // Spec answer Q5: reject negative deltas in Build 1
        if (delta_total < 0) {
          return jsonResponse({
            error: 'Downgrades aren\u2019t supported yet \u2014 please contact admin to handle this change manually.',
            code: 'DOWNGRADE_NOT_SUPPORTED'
          }, 400);
        }

        // v74j: compute the new deposit using the correct commission rate
        // and formula. Two fixes from the v74e code:
        //
        // 1. SOURCE: bookings don't carry commission_pct directly. The
        //    canonical source is the confirmed offer (snapshotted at offer
        //    creation as `commission_pct_at_time`). Fall back to the
        //    property's current `commission_pct` if the offer snapshot
        //    isn't available (shouldn't happen on confirmed bookings, but
        //    handle gracefully).
        //
        // 2. FORMULA: commission_pct is stored as a number 1-25 (representing
        //    1%-25%). The offer code uses `total * pct / 100`. The v74e
        //    fallback of 0.30 assumed a decimal fraction \u2014 wrong both in
        //    magnitude AND units. For your $1000 uplift at 15% commission,
        //    delta_deposit should be $150, which is what `1000 * 15 / 100`
        //    produces.
        let commission_pct_raw = null;
        // Prefer the confirmed-offer snapshot
        if (booking.confirmed_offer_id) {
          try {
            const cOfferRaw = await env.DOSSIERS.get('offer:' + booking.confirmed_offer_id);
            if (cOfferRaw) {
              const cOffer = JSON.parse(cOfferRaw);
              if (typeof cOffer.commission_pct_at_time === 'number') {
                commission_pct_raw = cOffer.commission_pct_at_time;
              }
            }
          } catch (e) { /* fall through to property lookup */ }
        }
        // Fall back to the property's current commission rate
        if (commission_pct_raw == null) {
          const slugForCommish = booking.slug || booking.propertySlug;
          if (slugForCommish) {
            try {
              const propRaw = await env.DOSSIERS.get(slugForCommish + ':property');
              if (propRaw) {
                const prop = JSON.parse(propRaw);
                if (typeof prop.commission_pct === 'number') {
                  commission_pct_raw = prop.commission_pct;
                }
              }
            } catch (e) { /* fall through to error */ }
          }
        }
        if (commission_pct_raw == null) {
          return jsonResponse({
            error: 'Cannot compute deposit: commission rate not found on offer or property record. This is a data integrity issue — contact admin.',
            code: 'NO_COMMISSION_PCT',
          }, 400);
        }

        const commission_pct = commission_pct_raw; // stored as 1-25 (1%-25%)
        const new_deposit = Math.round(total_amount * commission_pct) / 100;
        const delta_deposit = Math.round((new_deposit - previous_state.deposit_amount) * 100) / 100;

        // Create the amendment as a new offer record
        const amendmentId = 'offer_am_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const amendment = {
          id: amendmentId,
          bookingId: bookingRef,
          propertySlug: booking.slug || booking.propertySlug || null,
          // v74i: real bookings store the readable property name as
          // `booking.property` (set at line 1915 in the booking-create flow).
          // The v74e code was reading `booking.propertyName` which is
          // never set on bookings — only on offers and conversations. Same
          // class of field-name-mismatch bug as v74g's confirmed_total_amount.
          propertyName: booking.property || booking.propertyName || '',
          status: 'sent',           // amendments skip 'draft' \u2014 partner sends directly
          createdAt: new Date().toISOString(),
          sentAt: new Date().toISOString(),
          createdBy: isAdminCaller ? 'admin' : 'partner',

          // Trip fields (the proposed new state)
          room: room || previous_state.room,
          arrival: arrival || previous_state.arrival,
          departure: departure || previous_state.departure,
          guests: guests || previous_state.guests,
          total_amount: total_amount,
          deposit_amount: new_deposit,
          currency: booking.currency || 'USD',
          commission_pct: commission_pct,

          // Amendment-specific fields
          amendment_of: booking.active_offer_id || null,
          amendment_kind: amendment_kind,
          delta_total: delta_total,
          delta_deposit: delta_deposit,
          previous_state: previous_state,
          partner_note: partner_note || '',
        };

        // Write amendment offer
        await env.DOSSIERS.put('offer:' + amendmentId, JSON.stringify(amendment));

        // Append to per-booking offers index (treated as another offer for indexing)
        const offerIdxKey = '__offers_by_booking:' + bookingRef;
        const oidxRaw = await env.DOSSIERS.get(offerIdxKey);
        const oidx = oidxRaw ? JSON.parse(oidxRaw) : [];
        oidx.push(amendmentId);
        await env.DOSSIERS.put(offerIdxKey, JSON.stringify(oidx));

        // Update booking: track pending amendment, but DON'T touch effective state
        // until guest approves. We add to booking.offers (legacy compat) and set a
        // separate `pending_amendment_id` so the UI can show "amendment pending".
        if (!Array.isArray(booking.offers)) booking.offers = [];
        booking.offers.push(amendmentId);
        booking.pending_amendment_id = amendmentId;
        await env.DOSSIERS.put('booking:' + bookingRef, JSON.stringify(booking));

        // Post amendment_card system message into the linked conversation
        await postAmendmentCardToConversation(amendment, booking, 'amendment_card');

        // Email the guest. Loads guest email from booking record.
        const guestEmail = booking.email;
        const propertyName = booking.property || booking.propertyName || booking.slug || booking.propertySlug || 'your property';
        if (guestEmail && typeof sendBrandedEmail === 'function') {
          try {
            const replyToken = booking.conversationId
              ? ('reply+' + booking.conversationId + '@replies.thebearing.io')
              : undefined;
            const fmt = (n) => '$' + (n || 0).toLocaleString();
            const before = previous_state;
            const summaryRows = [];
            if (before.room !== amendment.room) {
              summaryRows.push({ label: 'Room', from: before.room, to: amendment.room });
            }
            if (before.arrival !== amendment.arrival || before.departure !== amendment.departure) {
              summaryRows.push({ label: 'Dates', from: before.arrival + ' \u2192 ' + before.departure, to: amendment.arrival + ' \u2192 ' + amendment.departure });
            }
            if ((before.guests || 0) !== (amendment.guests || 0)) {
              summaryRows.push({ label: 'Guests', from: String(before.guests), to: String(amendment.guests) });
            }
            if (before.total_amount !== amendment.total_amount) {
              summaryRows.push({ label: 'Total', from: fmt(before.total_amount), to: fmt(amendment.total_amount) });
            }
            const tableHtml =
              '<table style="width:100%;border-collapse:collapse;font-size:.9rem;margin:0 0 22px;">'
              + summaryRows.map(r =>
                  '<tr><td style="padding:8px 0;color:#7a6a58;width:35%;">' + r.label + '</td>'
                  + '<td style="padding:8px 0;color:#7a6a58;text-decoration:line-through;">' + r.from + '</td>'
                  + '<td style="padding:8px 0;color:#1e1810;font-weight:600;">\u2192 ' + r.to + '</td></tr>'
                ).join('')
              + '</table>'
              + (delta_total > 0
                  ? '<div style="background:#fff8f4;border:1px solid rgba(176,88,48,.18);border-radius:10px;padding:14px 18px;margin:0 0 22px;color:#5a4a38;">'
                    + '<strong style="color:#b05830;">Additional deposit due: ' + fmt(delta_deposit) + '</strong>'
                    + ' \u00b7 New total: ' + fmt(amendment.total_amount)
                    + '</div>'
                  : '<div style="background:#f5f1e9;border:1px solid rgba(80,55,25,.10);border-radius:10px;padding:14px 18px;margin:0 0 22px;color:#5a4a38;">'
                    + 'No price change. New total: ' + fmt(amendment.total_amount)
                    + '</div>'
                )
              + (partner_note
                  ? '<div style="border-left:3px solid rgba(176,88,48,.3);padding:6px 14px;margin:0 0 22px;color:#5a4a38;font-style:italic;">'
                    + '"' + partner_note.replace(/</g, '&lt;') + '"'
                    + '<div style="font-size:.74rem;color:#7a6a58;margin-top:6px;font-style:normal;">\u2014 ' + propertyName + '</div>'
                    + '</div>'
                  : '');
            await sendBrandedEmail({
              env, logTag: 'Amendment-Guest',
              to: [guestEmail],
              replyTo: replyToken,
              subject: 'Proposed change to your ' + propertyName + ' booking \u00b7 ' + bookingRef,
              text: 'A change has been proposed to your booking at ' + propertyName + '. Open your conversation to review and approve or decline: https://thebearing.io/conversations.html?id=' + (booking.conversationId || ''),
              shell: {
                preheader: propertyName + ' has proposed a change to your booking.',
                kicker: 'The Bearing',
                heading: 'A proposed change to your booking',
                intro: propertyName + ' has proposed the following change to your stay. Open your conversation to approve or decline.',
                bodyHtml: tableHtml,
                ctaUrl: 'https://thebearing.io/conversations.html?id=' + (booking.conversationId || ''),
                ctaLabel: 'Review the change',
                footerNote: 'You can reply directly to this email \u2014 your response will land back in your conversation with the property.',
                refLabel: bookingRef
              }
            });
          } catch(e) { console.error('[Amendment guest email] failed:', e.message); }
        }

        return jsonResponse({ ok: true, amendment });
      }

      // ─ PATCH ─ Guest approve or decline
      if (request.method === 'PATCH') {
        let body;
        try { body = await request.json(); }
        catch(_) { return jsonResponse({ error: 'invalid JSON' }, 400); }

        const { offerId, action, requesterEmail } = body;
        if (!offerId) return jsonResponse({ error: 'offerId required' }, 400);
        if (action !== 'approve' && action !== 'decline') {
          return jsonResponse({ error: 'action must be approve or decline' }, 400);
        }

        // Load amendment
        const amendmentRaw = await env.DOSSIERS.get('offer:' + offerId);
        if (!amendmentRaw) return jsonResponse({ error: 'amendment not found' }, 404);
        const amendment = JSON.parse(amendmentRaw);

        if (!amendment.amendment_of) {
          return jsonResponse({ error: 'this offer is not an amendment' }, 400);
        }
        if (amendment.status !== 'sent') {
          return jsonResponse({ error: 'amendment is no longer pending (status: ' + amendment.status + ')' }, 400);
        }

        // Load booking
        const bookingRaw = await env.DOSSIERS.get('booking:' + amendment.bookingId);
        if (!bookingRaw) return jsonResponse({ error: 'booking not found' }, 404);
        const booking = JSON.parse(bookingRaw);

        // Ownership check (matches /api/checkout/create-session pattern)
        const reqEmail = (requesterEmail || '').toLowerCase().trim();
        const bookEmail = (booking.email || '').toLowerCase().trim();
        const isAdminCaller = await isAdmin();
        if (!isAdminCaller && (!reqEmail || reqEmail !== bookEmail)) {
          return jsonResponse({ error: 'not authorized' }, 403);
        }

        const now = new Date().toISOString();

        if (action === 'decline') {
          amendment.status = 'declined';
          amendment.declinedAt = now;
          await env.DOSSIERS.put('offer:' + offerId, JSON.stringify(amendment));

          // Clear pending flag on booking
          if (booking.pending_amendment_id === offerId) {
            booking.pending_amendment_id = null;
            await env.DOSSIERS.put('booking:' + booking.ref, JSON.stringify(booking));
          }

          await postAmendmentCardToConversation(amendment, booking, 'amendment_declined');
          return jsonResponse({ ok: true, amendment, booking });
        }

        // action === 'approve'
        // v74j: PATCH approve is now ONLY for delta=0 amendments (no money
        // to collect — e.g. same-priced room swap, party reshuffle, date
        // change with no price impact). For delta>0 amendments, the client
        // routes through POST /api/amendment/checkout → Stripe → webhook
        // (see amendment-payment branch in the Stripe webhook handler).
        // This rejection prevents bypassing payment by directly PATCHing
        // approve on a delta>0 amendment.
        if ((amendment.delta_total || 0) > 0) {
          return jsonResponse({
            error: 'This amendment requires payment of the commission delta. Please use the Approve button in your conversation, which will route you to secure payment.',
            code: 'PAYMENT_REQUIRED',
          }, 400);
        }

        amendment.status = 'accepted';
        amendment.acceptedAt = now;
        await env.DOSSIERS.put('offer:' + offerId, JSON.stringify(amendment));

        // Original offer flips to superseded_by_amendment
        if (amendment.amendment_of) {
          const origRaw = await env.DOSSIERS.get('offer:' + amendment.amendment_of);
          if (origRaw) {
            const orig = JSON.parse(origRaw);
            orig.status = 'superseded_by_amendment';
            orig.superseded_by = offerId;
            await env.DOSSIERS.put('offer:' + amendment.amendment_of, JSON.stringify(orig));
          }
        }

        // Update booking record to reflect new effective state.
        // v74g: write both `confirmed_*` (canonical for confirmed bookings,
        // set by Stripe webhook originally) AND `total_amount`/`deposit_amount`
        // (legacy). Otherwise the bookings UI keeps showing the old total
        // because it reads `confirmed_total_amount`.
        booking.room = amendment.room;
        booking.arrival = amendment.arrival;
        booking.departure = amendment.departure;
        booking.guests = amendment.guests;
        booking.total_amount = amendment.total_amount;
        booking.deposit_amount = amendment.deposit_amount;
        booking.confirmed_total_amount = amendment.total_amount;
        booking.confirmed_deposit_amount = amendment.deposit_amount;
        // depositPaidAmount stays untouched — represents what was ACTUALLY
        // paid through Stripe. The delta gets invoiced manually (Build 1
        // stub) or via Stripe payment_intent (Build 2). Don't fake it here.
        booking.active_offer_id = offerId;
        if (!Array.isArray(booking.amendments)) booking.amendments = [];
        booking.amendments.push(offerId);
        booking.pending_amendment_id = null;
        booking.lastAmendedAt = now;
        await env.DOSSIERS.put('booking:' + booking.ref, JSON.stringify(booking));

        // Post amendment_accepted system card
        await postAmendmentCardToConversation(amendment, booking, 'amendment_accepted');

        // Email admin + partner.
        // v74j: this PATCH path only runs for delta=0 amendments (the
        // delta>0 guard above rejects them). So the deltaBlock simplifies
        // to "no additional invoicing required" \u2014 the delta>0 confirmation
        // email is sent from the Stripe webhook amendment-payment branch.
        if (typeof sendBrandedEmail === 'function') {
          try {
            const adminRecipients = await loadNotificationRecipients(env);
            const _bookingSlug = booking.slug || booking.propertySlug || '';
            const partnerEmail = booking.partnerEmail || (_bookingSlug ? ('partners-' + _bookingSlug + '@thebearing.io') : null);
            const recipients = [...adminRecipients];
            if (partnerEmail && recipients.indexOf(partnerEmail) === -1) recipients.push(partnerEmail);

            const fmt = (n) => '$' + (n || 0).toLocaleString();
            const propertyName = booking.property || booking.propertyName || _bookingSlug || 'Property';
            const before = amendment.previous_state;
            const deltaBlock =
              '<div style="background:#f5f1e9;border:1px solid rgba(80,55,25,.10);border-radius:10px;padding:14px 18px;margin:0 0 22px;color:#5a4a38;">No price change. No additional invoicing required.</div>';
            const beforeAfter =
              '<table style="width:100%;border-collapse:collapse;font-size:.9rem;margin:0 0 22px;">'
              + '<tr><td style="padding:6px 0;color:#7a6a58;width:35%;">Room</td>'
              +   '<td style="padding:6px 0;color:#7a6a58;text-decoration:line-through;">' + (before.room || '\u2014') + '</td>'
              +   '<td style="padding:6px 0;color:#1e1810;font-weight:600;">\u2192 ' + (amendment.room || '\u2014') + '</td></tr>'
              + '<tr><td style="padding:6px 0;color:#7a6a58;">Dates</td>'
              +   '<td style="padding:6px 0;color:#7a6a58;text-decoration:line-through;">' + before.arrival + ' \u2192 ' + before.departure + '</td>'
              +   '<td style="padding:6px 0;color:#1e1810;font-weight:600;">\u2192 ' + amendment.arrival + ' \u2192 ' + amendment.departure + '</td></tr>'
              + '<tr><td style="padding:6px 0;color:#7a6a58;">Guests</td>'
              +   '<td style="padding:6px 0;color:#7a6a58;text-decoration:line-through;">' + before.guests + '</td>'
              +   '<td style="padding:6px 0;color:#1e1810;font-weight:600;">\u2192 ' + amendment.guests + '</td></tr>'
              + '<tr><td style="padding:6px 0;color:#7a6a58;">Total</td>'
              +   '<td style="padding:6px 0;color:#7a6a58;text-decoration:line-through;">' + fmt(before.total_amount) + '</td>'
              +   '<td style="padding:6px 0;color:#1e1810;font-weight:600;">\u2192 ' + fmt(amendment.total_amount) + '</td></tr>'
              + '<tr><td style="padding:6px 0;color:#7a6a58;">Deposit</td>'
              +   '<td style="padding:6px 0;color:#7a6a58;text-decoration:line-through;">' + fmt(before.deposit_amount) + '</td>'
              +   '<td style="padding:6px 0;color:#1e1810;font-weight:600;">\u2192 ' + fmt(amendment.deposit_amount) + '</td></tr>'
              + '</table>';
            await sendBrandedEmail({
              env, logTag: 'Amendment-Internal',
              to: recipients,
              subject: '[CONFIRMED] Amendment \u00b7 ' + propertyName + ' \u00b7 ' + booking.ref,
              text: 'Amendment approved by guest.\n\nProperty: ' + propertyName + '\nBooking: ' + booking.ref + '\nKind: ' + amendment.amendment_kind + '\nDelta total: ' + fmt(amendment.delta_total) + '\nDelta deposit: ' + fmt(amendment.delta_deposit) + '\n\nACTION REQUIRED (Build 1 stub): Please manually invoice the guest for the deposit delta. Stripe wiring lands in Build 2.\n\nReview the conversation: https://thebearing.io/admin-conversations.html?id=' + (booking.conversationId || ''),
              shell: {
                preheader: 'Amendment approved \u2014 ' + fmt(amendment.delta_total) + ' delta to invoice.',
                kicker: 'The Bearing \u00b7 Internal',
                heading: 'Amendment approved & booking updated',
                intro: 'The guest has approved the proposed change to <strong>' + propertyName + '</strong> (' + booking.ref + ').',
                bodyHtml: beforeAfter + deltaBlock,
                ctaUrl: 'https://thebearing.io/admin-conversations.html?id=' + (booking.conversationId || ''),
                ctaLabel: 'Open the conversation',
                footerNote: 'You\u2019re receiving this because you handle confirmed bookings.',
                refLabel: booking.ref
              }
            });

            // Also email the guest a confirmation
            if (booking.email) {
              const replyToken = booking.conversationId
                ? ('reply+' + booking.conversationId + '@replies.thebearing.io')
                : undefined;
              await sendBrandedEmail({
                env, logTag: 'Amendment-Guest-Confirm',
                to: [booking.email],
                replyTo: replyToken,
                subject: 'Booking updated \u00b7 ' + propertyName + ' \u00b7 ' + booking.ref,
                text: 'Your booking change has been confirmed.\n\nNew details:\nRoom: ' + amendment.room + '\nDates: ' + amendment.arrival + ' \u2192 ' + amendment.departure + '\nGuests: ' + amendment.guests + '\nNew total: ' + fmt(amendment.total_amount) + (amendment.delta_total > 0 ? '\n\nThe property will send a separate invoice for the additional ' + fmt(amendment.delta_deposit) + ' deposit shortly.' : ''),
                shell: {
                  preheader: 'Your booking at ' + propertyName + ' has been updated.',
                  kicker: 'The Bearing',
                  heading: 'Your booking has been updated',
                  intro: 'Your change to <strong>' + propertyName + '</strong> has been confirmed. Here are the updated details.',
                  bodyHtml: beforeAfter
                    + (amendment.delta_total > 0
                        ? '<div style="background:#fff8f4;border:1px solid rgba(176,88,48,.18);border-radius:10px;padding:14px 18px;margin:0 0 22px;color:#5a4a38;">The property will send you a separate invoice for the additional <strong style="color:#b05830;">' + fmt(amendment.delta_deposit) + '</strong> deposit shortly.</div>'
                        : ''
                      ),
                  ctaUrl: 'https://thebearing.io/conversations.html?id=' + (booking.conversationId || ''),
                  ctaLabel: 'View the conversation',
                  footerNote: 'You can reply to this email \u2014 your response will land back in your conversation.',
                  refLabel: booking.ref
                }
              });
            }
          } catch(e) { console.error('[Amendment confirm email] failed:', e.message); }
        }

        return jsonResponse({ ok: true, amendment, booking });
      }

      return new Response('Method not allowed', { status: 405 });
    }

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
      const { offerId, requesterEmail, applyCredits, applyCreditsMemberId } = body;
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
      let depositCents = Math.round(Number(offer.deposit_amount || 0) * 100);
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

      // v74v: Reserve Credits redemption.
      // If the guest has ≥$4,000 earned AND this offer is for Nour El Nil
      // AND applyCredits=true, reduce the deposit and total proportionally
      // by $4,000. We CAPTURE the intent to redeem in PaymentIntent metadata
      // here but DO NOT mark the ledger redemption until payment succeeds
      // (handled in webhook + sync-payment, alongside the accrue logic).
      // This way an abandoned checkout doesn't burn the guest's credits.
      let creditsApplied = false;
      let creditsAppliedCents = 0;
      const totalCents = Math.round(Number(offer.total_amount || 0) * 100);
      if (applyCredits === true) {
        const offerSlug = String(offer.propertySlug || booking.slug || '').toLowerCase();
        if (CREDITS_EXCLUDED_SLUGS.indexOf(offerSlug) === -1) {
          // Excluded slugs are the ones that EARN credits. The REDEMPTION
          // property (Nour El Nil) is the OPPOSITE — credits ARE redeemable
          // there. So this check is inverted from the earn case.
          // Reject if applying credits to a non-Nour El Nil property.
          return jsonResponse({ error: 'Reserve Credits can only be applied to Nour El Nil bookings' }, 400);
        }
        const memberId = applyCreditsMemberId || booking.guestId || (await creditsResolveMemberId(env, booking));
        if (!memberId) {
          return jsonResponse({ error: 'cannot identify member for credit redemption' }, 400);
        }
        const state = await creditsLoadLedger(env, memberId);
        const bal = creditsComputeBalances(state.ledger);
        if (bal.earnedCents < CREDITS_GOAL_CENTS) {
          return jsonResponse({ error: 'insufficient Reserve Credits — earned: ' + bal.earnedCents + ' cents' }, 400);
        }
        if (totalCents <= 0) {
          return jsonResponse({ error: 'offer total invalid; cannot apply credits' }, 400);
        }
        // Proportional reduction: deposit shrinks by depositCents * 4000/totalDollars
        // (so a $7K offer with $2.1K deposit drops to $3K offer with $900 deposit).
        // If the $4K credit exceeds the total, deposit and total both go to zero
        // (free trip — guest pays $0 today).
        const reductionRatio = Math.min(1, CREDITS_GOAL_CENTS / totalCents);
        depositCents = Math.max(0, Math.round(depositCents * (1 - reductionRatio)));
        creditsApplied = true;
        creditsAppliedCents = CREDITS_GOAL_CENTS;

        // v74v: $0-deposit bypass. If credits cover the full booking (or bring
        // the deposit below Stripe's 50¢ minimum), skip Stripe entirely and
        // confirm the booking directly. Mirrors the post-payment flow from
        // the webhook/sync-payment handlers (accrue credits, mark redemption,
        // post conv message, mark offer accepted). Returns `skipStripe: true`
        // so the client knows to skip Payment Element mounting and just call
        // onSuccess immediately. This handles the rare "Nour El Nil offer
        // totalling ≤$4,000" edge case AND any case where credits >= deposit.
        if (depositCents < 50) {
          const memberId = applyCreditsMemberId || booking.guestId || (await creditsResolveMemberId(env, booking));
          if (!memberId) {
            return jsonResponse({ error: 'cannot identify member for credit redemption' }, 400);
          }
          // Verify balance one more time at the moment of mutation (race protection)
          const finalState = await creditsLoadLedger(env, memberId);
          const finalBal = creditsComputeBalances(finalState.ledger);
          if (finalBal.earnedCents < CREDITS_GOAL_CENTS) {
            return jsonResponse({ error: 'insufficient Reserve Credits (race lost)' }, 400);
          }
          const nowIso = new Date().toISOString();
          // Mark booking confirmed
          booking.status = 'confirmed';
          booking.paymentStatus = 'paid';  // no deposit owed; full credit covers it
          booking.depositPaidAmount = 0;
          booking.depositPaidAt = nowIso;
          booking.updatedAt = nowIso;
          booking.seenByPartner = false;
          booking.seenByAdmin = false;
          booking.confirmed_total_amount = offer.total_amount || 0;
          booking.confirmed_deposit_amount = offer.deposit_amount || 0;
          booking.confirmed_balance_due_date = offer.balance_due_date || '';
          booking.confirmed_inclusions = Array.isArray(offer.inclusions) ? offer.inclusions : [];
          booking.confirmed_exclusions = offer.exclusions || '';
          booking.confirmed_cancellation_terms = offer.cancellation_terms || '';
          booking.confirmed_partner_notes = offer.partner_notes || '';
          booking.confirmed_offer_id = offer.id;
          booking.confirmed_currency = offer.currency || 'USD';
          booking.creditsAppliedCents = CREDITS_GOAL_CENTS;
          await env.DOSSIERS.put('booking:' + offer.bookingId, JSON.stringify(booking));
          // Mark offer accepted
          try {
            offer.status = 'accepted';
            offer.responded_at = nowIso;
            await env.DOSSIERS.put('offer:' + offer.id, JSON.stringify(offer));
          } catch (_) {}
          // Redeem the credits (booking is Nour El Nil, validated above)
          try {
            await creditsRedeem(env, memberId, offer.bookingId);
          } catch (e) {
            console.error('[zero-deposit redeem] failed:', e && e.message);
          }
          // v74w: Founding Member reserve (a free trip is still a trip).
          try {
            const fmRes = await foundingMemberReserve(env, booking);
            if (fmRes && fmRes.ok && !fmRes.skipped) {
              console.log('[fm] zero-deposit reserved #' + fmRes.number + ' (pending) for ' + fmRes.memberId);
            }
          } catch (e) {
            console.error('[fm] reserve failed on zero-deposit:', e && e.message);
          }
          // Post conversation message
          const convId = booking.conversationId || '';
          if (convId) {
            try {
              const convRaw = await env.DOSSIERS.get('conversation:' + convId);
              if (convRaw) {
                const conv = JSON.parse(convRaw);
                const msgsRaw = await env.DOSSIERS.get('conversation:' + convId + ':messages');
                const messages = msgsRaw ? JSON.parse(msgsRaw) : [];
                messages.push({
                  id: 'msg_' + Date.now() + '_zerodep',
                  role: 'system',
                  type: 'booking_confirmed',
                  text: '\u2713 Booking confirmed with $4,000 Reserve Credits applied \u00b7 ' + offer.bookingId + '\n\nNo deposit owed today. The property has been notified.',
                  senderName: 'The Bearing',
                  sentAt: nowIso,
                  readAt: null,
                  bookingRef: offer.bookingId,
                });
                conv.lastMessageAt = nowIso;
                conv.lastMessagePreview = '\u2713 Booking confirmed (credits applied)';
                conv.unreadAdmin = (conv.unreadAdmin || 0) + 1;
                await env.DOSSIERS.put('conversation:' + convId, JSON.stringify(conv));
                await env.DOSSIERS.put('conversation:' + convId + ':messages', JSON.stringify(messages));
                try { await recomputeUnreadCounters(env); } catch(_) {}
              }
            } catch (e) {
              console.error('[zero-deposit conv message] failed:', e && e.message);
            }
          }
          return jsonResponse({
            ok: true,
            skipStripe: true,
            bookingRef: offer.bookingId,
            status: 'confirmed',
            creditsAppliedCents: CREDITS_GOAL_CENTS,
            message: 'Booking confirmed with $4,000 Reserve Credits applied.',
          });
        }
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
            // v74v: redemption intent — applied at deposit-paid event
            creditsApplied: creditsApplied ? 'true' : 'false',
            creditsAppliedCents: String(creditsAppliedCents || 0),
            creditsMemberId: applyCreditsMemberId || booking.guestId || '',
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
      // v73ah: mark unseen by partner + admin (admin already "sees" it by
      // running the rescue, but we set the flag for consistency \u2014 admin can
      // mark seen by opening the row).
      booking.seenByPartner = false;
      booking.seenByAdmin = false;
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
        // v73ai: defensive trip-details backfill (legacy bookings)
        if (!booking.arrival   && acceptedOffer.arrival)   booking.arrival   = acceptedOffer.arrival;
        if (!booking.departure && acceptedOffer.departure) booking.departure = acceptedOffer.departure;
        if (!booking.nights    && acceptedOffer.nights)    booking.nights    = acceptedOffer.nights;
        if (!booking.guests    && acceptedOffer.guests)    booking.guests    = acceptedOffer.guests;
        if (!booking.room      && acceptedOffer.room)      booking.room      = acceptedOffer.room;
      }
      await env.DOSSIERS.put('booking:' + bookingRef, JSON.stringify(booking));

      // v74v: Reserve Credits — accrue 10% pending credits on deposit paid.
      // Idempotent helper handles dedup, Nour El Nil exclusion, and member resolve.
      try {
        const credRes = await creditsAccrueOnDeposit(env, booking);
        if (credRes && credRes.ok && !credRes.skipped) {
          console.log('[credits] accrued $' + (credRes.amountCents / 100) + ' pending for ' + credRes.memberId + ' from booking ' + bookingRef);
        }
        // If the PaymentIntent metadata flags creditsApplied=true, mark the
        // $4,000 redemption now (only after payment success). Rescue path
        // reads metadata from pi.metadata.
        const piMeta = (pi && pi.metadata) || {};
        if (piMeta.creditsApplied === 'true') {
          const redeemMemberId = piMeta.creditsMemberId || booking.guestId || (await creditsResolveMemberId(env, booking));
          if (redeemMemberId) {
            const redeemRes = await creditsRedeem(env, redeemMemberId, bookingRef);
            if (redeemRes && redeemRes.ok && !redeemRes.skipped) {
              console.log('[credits] redeemed $4,000 for ' + redeemMemberId + ' on booking ' + bookingRef);
            }
          }
        }
      } catch (e) {
        console.error('[credits] accrue/redeem failed on rescue path:', e && e.message);
      }

      // v74w: Founding Member — reserve pending FM status on deposit paid.
      // Idempotent (no-op if member already enrolled). Cap-enforced (no-op
      // once 1,000 spots filled).
      try {
        const fmRes = await foundingMemberReserve(env, booking);
        if (fmRes && fmRes.ok && !fmRes.skipped) {
          console.log('[fm] reserved #' + fmRes.number + ' (pending) for ' + fmRes.memberId + ' on rescue path');
        }
      } catch (e) {
        console.error('[fm] reserve failed on rescue path:', e && e.message);
      }

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

      // v74k: AMENDMENT BRANCH. If the PaymentIntent metadata has an
      // amendmentId, this is a delta-deposit payment for a booking
      // amendment. Different shape from initial-offer payments (booking
      // is already deposit_paid; we add to depositPaidAmount; flip the
      // amendment to accepted; update booking with amendment values).
      // Dispatch to shared helper (same one the Stripe webhook uses).
      if (meta.amendmentId) {
        const amBookingRef = meta.bookingRef;
        if (!amBookingRef) {
          return jsonResponse({ error: 'PaymentIntent missing bookingRef' }, 400);
        }
        const amBookingRaw = await env.DOSSIERS.get('booking:' + amBookingRef);
        if (!amBookingRaw) {
          return jsonResponse({ error: 'booking not found' }, 404);
        }
        const amBooking = JSON.parse(amBookingRaw);
        const amBookingEmail = (amBooking.email || '').toLowerCase().trim();
        const amReqEmail = (requesterEmail || '').toLowerCase().trim();
        if (!amBookingEmail || amBookingEmail !== amReqEmail) {
          return jsonResponse({ error: 'not authorised for this booking' }, 403);
        }

        const result = await confirmAmendmentPayment(env, {
          amendmentId: meta.amendmentId,
          bookingRef: amBookingRef,
          sessionId: pi.id,
          amountPaid: Number(pi.amount_received || pi.amount || 0) / 100,
        });
        if (!result.ok) {
          return jsonResponse({ error: result.error || 'amendment confirm failed', status: result.status }, 500);
        }
        return jsonResponse({
          ok: true,
          status: result.status,
          amendmentId: result.amendmentId,
          bookingRef: result.bookingRef,
        });
      }

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
      // v73ah: mark unseen by partner + admin
      booking.seenByPartner = false;
      booking.seenByAdmin = false;
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
        // v73ai: defensive trip-details backfill (see admin sync for context)
        if (!booking.arrival   && acceptedOffer.arrival)   booking.arrival   = acceptedOffer.arrival;
        if (!booking.departure && acceptedOffer.departure) booking.departure = acceptedOffer.departure;
        if (!booking.nights    && acceptedOffer.nights)    booking.nights    = acceptedOffer.nights;
        if (!booking.guests    && acceptedOffer.guests)    booking.guests    = acceptedOffer.guests;
        if (!booking.room      && acceptedOffer.room)      booking.room      = acceptedOffer.room;
      }
      await env.DOSSIERS.put('booking:' + bookingRef, JSON.stringify(booking));

      // v74v: Reserve Credits — accrue 10% pending credits on deposit paid.
      try {
        const credRes = await creditsAccrueOnDeposit(env, booking);
        if (credRes && credRes.ok && !credRes.skipped) {
          console.log('[credits] accrued $' + (credRes.amountCents / 100) + ' pending for ' + credRes.memberId + ' from booking ' + bookingRef);
        }
        const piMeta = (pi && pi.metadata) || {};
        if (piMeta.creditsApplied === 'true') {
          const redeemMemberId = piMeta.creditsMemberId || booking.guestId || (await creditsResolveMemberId(env, booking));
          if (redeemMemberId) {
            const redeemRes = await creditsRedeem(env, redeemMemberId, bookingRef);
            if (redeemRes && redeemRes.ok && !redeemRes.skipped) {
              console.log('[credits] redeemed $4,000 for ' + redeemMemberId + ' on booking ' + bookingRef);
            }
          }
        }
      } catch (e) {
        console.error('[credits] accrue/redeem failed on sync-payment:', e && e.message);
      }

      // v74w: Founding Member reserve
      try {
        const fmRes = await foundingMemberReserve(env, booking);
        if (fmRes && fmRes.ok && !fmRes.skipped) {
          console.log('[fm] reserved #' + fmRes.number + ' (pending) for ' + fmRes.memberId + ' on sync-payment');
        }
      } catch (e) {
        console.error('[fm] reserve failed on sync-payment:', e && e.message);
      }

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

    // ── /api/amendment/create-intent ───────────────────────────────
    // v74k: inline Stripe Payment Element flow for amendment delta charge.
    // Replaces v74j's /api/amendment/checkout (which redirected to a
    // hosted Stripe Checkout page) so the guest pays without leaving the
    // Bearing. Mirrors the deposit-payment /api/checkout/create-intent
    // pattern exactly.
    //
    // POST body: { amendmentId, requesterEmail }
    // Returns: { client_secret, publishable_key, payment_intent_id, amount, currency }
    //
    // Charges only the COMMISSION delta (e.g. for a $1000 uplift at 15%:
    // $150 to The Bearing inline; property collects remaining $850 directly).
    //
    // On confirmPayment success the client calls /api/checkout/sync-payment
    // (which now has an amendment branch — see v74k below) to run the
    // amendment-confirm flow. The Stripe webhook will also fire and is
    // idempotent with the sync call.
    if (url.pathname === '/api/amendment/create-intent') {
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      const stripe = getStripe(env);
      if (!stripe) return jsonResponse({ error: 'Stripe not configured' }, 503);
      if (!env.STRIPE_PUBLISHABLE_KEY) {
        console.error('[Amendment/intent] STRIPE_PUBLISHABLE_KEY not set');
        return jsonResponse({ error: 'Stripe publishable key not configured' }, 503);
      }

      let body;
      try { body = await request.json(); }
      catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
      const { amendmentId, requesterEmail } = body;
      if (!amendmentId) return jsonResponse({ error: 'amendmentId required' }, 400);
      if (!requesterEmail) return jsonResponse({ error: 'requesterEmail required' }, 400);

      const amRaw = await env.DOSSIERS.get('offer:' + amendmentId);
      if (!amRaw) return jsonResponse({ error: 'amendment not found' }, 404);
      const amendment = JSON.parse(amRaw);

      if (!amendment.amendment_of) {
        return jsonResponse({ error: 'this offer is not an amendment' }, 400);
      }
      if (amendment.status !== 'sent') {
        return jsonResponse({ error: 'amendment is no longer pending (status: ' + amendment.status + ')' }, 400);
      }

      const bookingRaw = await env.DOSSIERS.get('booking:' + amendment.bookingId);
      if (!bookingRaw) return jsonResponse({ error: 'booking not found' }, 404);
      const booking = JSON.parse(bookingRaw);

      const reqEmail = (requesterEmail || '').toLowerCase().trim();
      const bookEmail = (booking.email || '').toLowerCase().trim();
      const isAdminCaller = await isAdmin();
      if (!isAdminCaller && (!reqEmail || reqEmail !== bookEmail)) {
        return jsonResponse({ error: 'not authorized' }, 403);
      }

      const deltaDeposit = Number(amendment.delta_deposit) || 0;
      if (deltaDeposit <= 0) {
        return jsonResponse({ error: 'amendment has no positive deposit delta \u2014 no payment needed' }, 400);
      }

      const depositCents = Math.round(deltaDeposit * 100);
      if (depositCents < 50) {
        return jsonResponse({ error: 'delta below Stripe minimum charge (50 cents)' }, 400);
      }

      const propertyName = booking.property || booking.propertyName || amendment.propertyName || 'TheBearing booking';
      const productName = propertyName + ' \u2014 deposit for booking change';
      let productDescription = '';
      if (amendment.arrival && amendment.departure) {
        productDescription = amendment.arrival + ' \u2192 ' + amendment.departure;
      }
      if (amendment.room) {
        productDescription = (productDescription ? productDescription + ' \u00b7 ' : '') + amendment.room;
      }

      try {
        const intent = await stripe.paymentIntents.create({
          amount: depositCents,
          currency: (amendment.currency || 'usd').toLowerCase(),
          automatic_payment_methods: { enabled: true },
          receipt_email: bookEmail || undefined,
          description: productName + (productDescription ? ' (' + productDescription + ')' : ''),
          metadata: {
            // amendmentId is the routing key — webhook + sync-payment use
            // it to dispatch to the amendment-confirm branch.
            amendmentId: amendment.id,
            bookingRef: amendment.bookingId,
            propertySlug: amendment.propertySlug || booking.slug || '',
            conversationId: booking.conversationId || '',
            // inlineFlow = 'true' tells the webhook to process this PI
            // (skip the fromCheckout deferral). Same flag the deposit
            // inline flow uses.
            inlineFlow: 'true',
          },
          statement_descriptor_suffix: 'BEARING',
        });
        console.log('[Amendment/intent] created PI ' + intent.id + ' for amendment ' + amendment.id + ' (' + depositCents + ' cents)');
        return jsonResponse({
          client_secret: intent.client_secret,
          publishable_key: env.STRIPE_PUBLISHABLE_KEY,
          payment_intent_id: intent.id,
          amount: depositCents,
          currency: (amendment.currency || 'usd').toLowerCase(),
        });
      } catch (err) {
        console.error('[Amendment/intent] Stripe error:', err && err.message);
        return jsonResponse({ error: 'PaymentIntent creation failed: ' + (err.message || 'unknown') }, 500);
      }
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

          // ─────────────────────────────────────────────────────────────
          // v74j: AMENDMENT PAYMENT BRANCH
          // ─────────────────────────────────────────────────────────────
          // If the session metadata includes `amendmentId`, this is a
          // delta-deposit payment for a booking amendment (Build 2).
          // Different shape from initial-offer payments:
          //   - booking is already deposit_paid (don't flip status)
          //   - we add to depositPaidAmount, don't replace it
          //   - we flip the amendment offer to 'accepted' and mark the
          //     original offer 'superseded_by_amendment'
          //   - update booking's effective state (room/dates/etc) to the
          //     amendment values
          //   - post amendment_accepted system card
          //   - send confirmation emails
          if (meta.amendmentId) {
            // v74k: delegate to shared helper. Same logic now runs from
            // /api/checkout/sync-payment (called by the inline flow on
            // confirmPayment success). Idempotent — whichever path fires
            // first wins.
            const result = await confirmAmendmentPayment(env, {
              amendmentId: meta.amendmentId,
              bookingRef: meta.bookingRef,
              sessionId: session.id,
              amountPaid: Number(session.amount_total || 0) / 100,
            });
            console.log('[Stripe webhook][amendment]', result);
            return jsonResponse({ received: true, type: event.type, status: result.status });
          }
          // ─────────────────────────────────────────────────────────────
          // END AMENDMENT PAYMENT BRANCH
          // ─────────────────────────────────────────────────────────────

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
          // v73ah: mark unseen by partner + admin so their Bookings sidebar
          // badges fire until each views the booking detail.
          booking.seenByPartner = false;
          booking.seenByAdmin = false;
          // v73aa: snapshot key offer fields for customer detail view.
          // v73ai: booking.arrival/departure/etc should already be set from
          // the v73ai offer-send sync. The defensive backfill below covers
          // legacy bookings that were sent pre-v73ai (still have empty trip
          // fields on the booking).
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
            // v73ai: backfill trip details if booking still lacks them
            if (!booking.arrival   && acceptedOffer.arrival)   booking.arrival   = acceptedOffer.arrival;
            if (!booking.departure && acceptedOffer.departure) booking.departure = acceptedOffer.departure;
            if (!booking.nights    && acceptedOffer.nights)    booking.nights    = acceptedOffer.nights;
            if (!booking.guests    && acceptedOffer.guests)    booking.guests    = acceptedOffer.guests;
            if (!booking.room      && acceptedOffer.room)      booking.room      = acceptedOffer.room;
          }
          await env.DOSSIERS.put('booking:' + bookingRef, JSON.stringify(booking));

          // v74v: Reserve Credits — accrue 10% pending credits on deposit paid.
          // Webhook path is the canonical trigger; sync-payment is the
          // belt-and-suspenders. accrueOnDeposit is idempotent on
          // (bookingRef + 'deposit_paid'), so double-firing across webhook +
          // sync-payment is safe — only one ledger entry is created.
          try {
            const credRes = await creditsAccrueOnDeposit(env, booking);
            if (credRes && credRes.ok && !credRes.skipped) {
              console.log('[credits] webhook accrued $' + (credRes.amountCents / 100) + ' pending for ' + credRes.memberId + ' from ' + bookingRef);
            }
            // Redemption from session.metadata (Stripe Checkout flow) or pi.metadata (inline flow)
            const sessMeta = (session && session.metadata) || {};
            if (sessMeta.creditsApplied === 'true') {
              const redeemMemberId = sessMeta.creditsMemberId || booking.guestId || (await creditsResolveMemberId(env, booking));
              if (redeemMemberId) {
                const redeemRes = await creditsRedeem(env, redeemMemberId, bookingRef);
                if (redeemRes && redeemRes.ok && !redeemRes.skipped) {
                  console.log('[credits] webhook redeemed $4,000 for ' + redeemMemberId + ' on ' + bookingRef);
                }
              }
            }
          } catch (e) {
            console.error('[credits] accrue/redeem failed on webhook:', e && e.message);
          }

          // v74w: Founding Member reserve
          try {
            const fmRes = await foundingMemberReserve(env, booking);
            if (fmRes && fmRes.ok && !fmRes.skipped) {
              console.log('[fm] webhook reserved #' + fmRes.number + ' (pending) for ' + fmRes.memberId);
            }
          } catch (e) {
            console.error('[fm] reserve failed on webhook:', e && e.message);
          }

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
          //   - Partner: loadPartnerRecipients(slug) — per-property partner_emails
          //     field (v73al). Falls back to PARTNER_EMAIL_TRANSITION_DEFAULT
          //     until each property has its real partner_emails configured.
          if (env.RESEND_API_KEY) {
            const customerEmail = booking.email;
            const adminRecipients = await loadNotificationRecipients(env);
            const partnerRecipients = await loadPartnerRecipients(booking.slug || booking.propertySlug, env);
            const propName = booking.property || booking.slug || 'Property';
            const stayLine = (booking.arrival && booking.departure)
              ? booking.arrival + ' \u2192 ' + booking.departure + (booking.nights ? ' \u00b7 ' + booking.nights + ' nights' : '')
              : '';
            const roomLine = booking.room || '';
            const guestName = (booking.firstname || '') + (booking.lastname ? ' ' + booking.lastname : '');
            const ePropName = escapeEmailHtml(propName);
            const eStayLine = escapeEmailHtml(stayLine);
            const eRoomLine = escapeEmailHtml(roomLine);
            const eGuestName = escapeEmailHtml(guestName);
            const eCustomerEmail = escapeEmailHtml(customerEmail || 'no email');
            const eDepositPaid = escapeEmailHtml(depositPaid.toLocaleString());

            const guestBookingDetails =
              '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:20px;margin:0 0 22px;">'
              + '<div style="font-size:.7rem;color:#7a6a58;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">Booking</div>'
              + '<div style="font-family:\'Instrument Serif\',\'Cormorant Garamond\',Georgia,serif;font-size:1.2rem;margin-bottom:6px;color:#1e1810;">' + ePropName + '</div>'
              + (stayLine ? '<div style="color:#5a4a38;margin-bottom:4px;font-size:.92rem;">' + eStayLine + '</div>' : '')
              + (roomLine ? '<div style="color:#5a4a38;margin-bottom:4px;font-size:.92rem;">' + eRoomLine + '</div>' : '')
              + '<div style="color:#7a6a58;font-size:.85rem;margin-top:10px;">Reference: <strong>' + escapeEmailHtml(bookingRef) + '</strong></div>'
              + '</div>';

            // Customer confirmation
            if (customerEmail) {
              // v73at: route guest replies into the conversation thread (same
              // pattern as Booking-Confirm-Partner below). Without this, a
              // guest hitting "reply" on the confirmation lands at the
              // bookings@thebearing.io alias instead of the property conv.
              const _bcGuestConvId = booking.conversationId || null;
              await sendBrandedEmail({
                env, logTag: 'Booking-Confirm-Guest',
                to: [customerEmail],
                replyTo: _bcGuestConvId ? 'reply+' + _bcGuestConvId + '@replies.thebearing.io' : undefined,
                subject: 'Booking confirmed \u00b7 ' + propName + ' \u00b7 ' + bookingRef,
                text: 'Hi ' + (guestName || 'there') + ',\n\nYour deposit of $' + depositPaid.toLocaleString() + ' has been received and your stay at ' + propName + ' is confirmed.\n\n' + (stayLine ? stayLine + '\n' : '') + (roomLine ? roomLine + '\n' : '') + 'Reference: ' + bookingRef + '\n\nThe property has been notified and will be in touch directly with check-in details and any remaining balance.\n\nView this booking: https://thebearing.io/bookings\n\nBon voyage,\nThe Bearing',
                shell: {
                  preheader: 'Your stay at ' + propName + ' is confirmed.',
                  kicker: 'The Bearing',
                  heading: 'Your booking is confirmed',
                  intro: 'Hi ' + (eGuestName || 'there') + ', your deposit of <strong>$' + eDepositPaid + '</strong> has been received and your stay at <strong>' + ePropName + '</strong> is confirmed.',
                  bodyHtml: guestBookingDetails,
                  ctaUrl: 'https://thebearing.io/bookings',
                  ctaLabel: 'View booking',
                  footerNote: 'The property has been notified and will be in touch directly with check-in details and any remaining balance.',
                  refLabel: bookingRef
                }
              });
            }

            // Admin notification
            if (adminRecipients.length) {
              const adminDetailsHtml =
                '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
                + '<table cellpadding="0" cellspacing="0" border="0" width="100%">'
                + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;width:130px;">Property</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + ePropName + '</td></tr>'
                + (stayLine ? '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Dates</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + eStayLine + '</td></tr>' : '')
                + (roomLine ? '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Room</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + eRoomLine + '</td></tr>' : '')
                + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Guest</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + (eGuestName || eCustomerEmail) + ' \u00b7 ' + eCustomerEmail + '</td></tr>'
                + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Deposit paid</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;font-weight:600;">$' + eDepositPaid + '</td></tr>'
                + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Stripe session</td><td style="padding:8px 0;color:#1e1810;font-size:.82rem;"><code style="font-family:\'JetBrains Mono\',Consolas,monospace;background:rgba(80,55,25,.06);padding:1px 6px;border-radius:4px;">' + escapeEmailHtml(session.id) + '</code></td></tr>'
                + '</table></div>';
              await sendBrandedEmail({
                env, logTag: 'Booking-Confirm-Admin',
                from: 'The Bearing Bookings <bookings@thebearing.io>',
                to: adminRecipients,
                subject: '[CONFIRMED] ' + propName + ' \u00b7 ' + bookingRef + ' \u00b7 $' + depositPaid.toLocaleString(),
                text: 'Booking confirmed: ' + propName + ' (' + bookingRef + ')\n\nGuest: ' + (guestName || customerEmail || 'unknown') + ' \u00b7 ' + (customerEmail || 'no email') + '\nDeposit paid: $' + depositPaid.toLocaleString() + '\nStripe session: ' + session.id + '\n\nView in admin: https://thebearing.io/admin-bookings',
                shell: {
                  preheader: 'Booking confirmed at ' + propName,
                  kicker: 'The Bearing \u00b7 Admin',
                  heading: 'Booking confirmed',
                  intro: 'Deposit received and the booking is locked in.',
                  bodyHtml: adminDetailsHtml,
                  ctaUrl: 'https://thebearing.io/admin-bookings',
                  ctaLabel: 'Open in admin',
                  refLabel: bookingRef
                }
              });
            }

            // Partner notification \u2014 per-property emails (v73al). Filter
            // out any address already in adminRecipients to avoid duplicate
            // emails when admin and partner share an inbox.
            // v73as: gate by shouldSendPartnerEmail('deposit_paid'). Load conv
            // for per-thread mute, fall through to settings-only otherwise.
            const partnerToSend = partnerRecipients.filter(function(e) {
              return adminRecipients.indexOf(e) === -1;
            });
            const _depositSlug = booking.slug || booking.propertySlug || '';
            let _depositConv = null;
            if (booking.conversationId) {
              try {
                const _dcr = await env.DOSSIERS.get('conversation:' + booking.conversationId);
                if (_dcr) _depositConv = JSON.parse(_dcr);
              } catch(_) {}
            }
            const _depositGate = await shouldSendPartnerEmail('deposit_paid', _depositConv || {}, _depositSlug, env);
            if (partnerToSend.length && _depositGate) {
              // v73am: reply_to + ppUrl with ?as=slug so partner can reply via
              // email or open the conversation in their portal.
              const convIdForPartner = booking.conversationId || null;
              const propSlug = booking.slug || booking.propertySlug || '';
              const ppUrl = (convIdForPartner && propSlug)
                ? 'https://thebearing.io/pp-conversations.html?id=' + encodeURIComponent(convIdForPartner) + '&as=' + encodeURIComponent(propSlug)
                : '';
              const partnerDetailsHtml =
                '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
                + '<table cellpadding="0" cellspacing="0" border="0" width="100%">'
                + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;width:130px;">Property</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + ePropName + '</td></tr>'
                + (stayLine ? '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Dates</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + eStayLine + '</td></tr>' : '')
                + (roomLine ? '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Room</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + eRoomLine + '</td></tr>' : '')
                + '<tr><td style="padding:8px 0;color:#7a6a58;font-size:.85rem;">Guest</td><td style="padding:8px 0;color:#1e1810;font-size:.92rem;">' + (eGuestName || eCustomerEmail) + ' \u00b7 ' + eCustomerEmail + '</td></tr>'
                + '</table></div>';
              await sendBrandedEmail({
                env, logTag: 'Booking-Confirm-Partner',
                from: 'The Bearing Bookings <bookings@thebearing.io>',
                to: partnerToSend,
                replyTo: convIdForPartner ? 'reply+' + convIdForPartner + '@replies.thebearing.io' : undefined,
                subject: '[PARTNER] New confirmed booking \u00b7 ' + propName + ' \u00b7 ' + bookingRef,
                text: 'New confirmed booking at ' + propName + ' (' + bookingRef + ').\n\n' + (stayLine ? stayLine + '\n' : '') + (roomLine ? 'Room: ' + roomLine + '\n' : '') + 'Guest: ' + (guestName || customerEmail || 'unknown') + ' \u00b7 ' + (customerEmail || 'no email') + '\n\nThe guest will receive their own confirmation. Please reach out directly to coordinate check-in and remaining balance.\n\n' + (ppUrl ? 'Open the conversation: ' + ppUrl + '\n\n' : '') + '\u2014 The Bearing',
                shell: {
                  preheader: 'New confirmed booking at ' + propName,
                  kicker: 'The Bearing \u00b7 Partner',
                  heading: 'New confirmed booking',
                  intro: 'You have a confirmed booking at <strong>' + ePropName + '</strong>.',
                  bodyHtml: partnerDetailsHtml,
                  ctaUrl: ppUrl,
                  ctaLabel: ppUrl ? 'Open conversation' : '',
                  footerNote: 'The guest will receive their own confirmation. Please reach out directly to coordinate check-in and remaining balance.',
                  refLabel: bookingRef
                }
              });
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
  // Runs hourly. Two jobs:
  //   - Staleness reminders for conversations awaiting admin reply.
  //   - v74v: Reserve Credits promotion+expiry scan (only needs daily, but
  //     since cron fires hourly we run it every hour — operations are
  //     idempotent so re-running is safe and the volume is small).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runStaleConvReminders(env));
    ctx.waitUntil(creditsRunPromotionScan(env).catch(function(e) {
      console.error('[credits-cron] scan failed:', e && e.message);
    }));
    ctx.waitUntil(foundingMemberRunPromotionScan(env).catch(function(e) {
      console.error('[fm-cron] scan failed:', e && e.message);
    }));
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

      // v73al: resolve partner recipients via loadPartnerRecipients helper
      // (reads property.partner_emails, falls back to transition default).
      // partnerName still comes from property.name for the email body, so
      // we read the property record separately for that.
      let partnerName = conv.propertyName || conv.propertySlug;
      if (conv.propertySlug) {
        try {
          const propRaw = await env.DOSSIERS.get(conv.propertySlug + ':property');
          if (propRaw) {
            const prop = JSON.parse(propRaw);
            if (prop && prop.name) partnerName = prop.name;
          }
        } catch(e) {}
      }
      const partnerRecipients = await loadPartnerRecipients(conv.propertySlug, env);

      const replyUrl = 'https://thebearing.io/admin-conversations.html?id=' + encodeURIComponent(id);
      // v73am: ppUrl includes ?as=slug so the partner-portal page knows
      // which property's conversations to scope to.
      const ppUrl = 'https://thebearing.io/pp-conversations.html?id=' + encodeURIComponent(id)
                  + '&as=' + encodeURIComponent(conv.propertySlug || '');
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

      const partnerBody = `${tones[level]}\n\nGuest: ${guestLabel}\nProperty: ${partnerName}\nLast message:\n"${preview}"\n\nReply directly to this email, or open the conversation: ${ppUrl}\n\n— The Bearing`;
      const adminBody = `Stale conversation (${level}h+ wait).\n\nGuest: ${guestLabel}\nProperty: ${partnerName}\nLast message:\n"${preview}"\n\nView conversation: ${replyUrl}\n\n— The Bearing reminder system`;

      // 24h: notify partner only. 48h+: notify partner AND admin.
      const sendPromises = [];
      // v73al: filter out partner emails already in adminRecipients for the
      // 48h+ case so no duplicates. For 24h-only-to-partner case, send the
      // full partner list as-is.
      const partnerToSend = (level >= 48)
        ? partnerRecipients.filter(function(e) { return adminRecipients.indexOf(e) === -1; })
        : partnerRecipients.slice();
      // v73as: replaced bare `conv.notifyPartner !== false` with the full
      // shouldSendPartnerEmail gate so universal/per-event/per-property
      // settings all apply to stale reminders too.
      const _staleGate = await shouldSendPartnerEmail('stale_reminder', conv, conv.propertySlug || '', env);
      const notifyPartner = partnerToSend.length > 0 && _staleGate;
      const notifyAdmin = conv.notifyAdmin !== false;

      if (notifyPartner) {
        const ePartnerName = escapeEmailHtml(partnerName);
        const eGuestLabel = escapeEmailHtml(guestLabel);
        const ePreview = escapeEmailHtml(preview);
        const levelBadge = level >= 72 ? 'Urgent \u00b7 72h+' : (level >= 48 ? 'Escalating \u00b7 48h+' : 'Reminder \u00b7 24h+');
        const accentColor = level >= 72 ? '#c0392b' : (level >= 48 ? '#d97706' : '#b05830');
        const partnerStaleBlock =
          '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
          + '<div style="font-size:.7rem;color:' + accentColor + ';letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px;font-weight:700;">' + levelBadge + '</div>'
          + '<table cellpadding="0" cellspacing="0" border="0" width="100%">'
          + '<tr><td style="padding:6px 0;color:#7a6a58;font-size:.85rem;width:90px;">Guest</td><td style="padding:6px 0;color:#1e1810;font-size:.92rem;">' + eGuestLabel + '</td></tr>'
          + '<tr><td style="padding:6px 0;color:#7a6a58;font-size:.85rem;">Property</td><td style="padding:6px 0;color:#1e1810;font-size:.92rem;">' + ePartnerName + '</td></tr>'
          + '</table>'
          + (preview ? '<div style="margin-top:14px;padding-top:14px;border-top:1px solid rgba(80,55,25,.08);"><div style="font-size:.7rem;color:#7a6a58;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">Last message</div><div style="white-space:pre-wrap;line-height:1.55;color:#1e1810;font-size:.92rem;">"' + ePreview + '"</div></div>' : '')
          + '</div>';
        sendPromises.push(sendBrandedEmail({
          env, logTag: 'Cron-Stale-Partner',
          to: partnerToSend,
          replyTo: 'reply+' + id + '@replies.thebearing.io',
          subject: subjects[level],
          text: partnerBody,
          shell: {
            preheader: tones[level],
            kicker: 'The Bearing \u00b7 Partner',
            heading: subjects[level],
            intro: tones[level],
            bodyHtml: partnerStaleBlock,
            ctaUrl: ppUrl,
            ctaLabel: 'Open conversation',
            footerNote: 'Or reply directly to this email \u2014 your response will be sent to the guest.'
          }
        }));
      }

      if (level >= 48 && notifyAdmin) {
        const ePartnerName = escapeEmailHtml(partnerName);
        const eGuestLabel = escapeEmailHtml(guestLabel);
        const ePreview = escapeEmailHtml(preview);
        const adminLevelBadge = level >= 72 ? 'Urgent \u00b7 72h+' : 'Escalating \u00b7 48h+';
        const adminAccent = level >= 72 ? '#c0392b' : '#d97706';
        const adminStaleBlock =
          '<div style="background:#ffffff;border:1px solid rgba(80,55,25,.12);border-radius:12px;padding:18px 20px;margin:0 0 22px;">'
          + '<div style="font-size:.7rem;color:' + adminAccent + ';letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px;font-weight:700;">' + adminLevelBadge + '</div>'
          + '<table cellpadding="0" cellspacing="0" border="0" width="100%">'
          + '<tr><td style="padding:6px 0;color:#7a6a58;font-size:.85rem;width:90px;">Guest</td><td style="padding:6px 0;color:#1e1810;font-size:.92rem;">' + eGuestLabel + '</td></tr>'
          + '<tr><td style="padding:6px 0;color:#7a6a58;font-size:.85rem;">Property</td><td style="padding:6px 0;color:#1e1810;font-size:.92rem;">' + ePartnerName + '</td></tr>'
          + '</table>'
          + (preview ? '<div style="margin-top:14px;padding-top:14px;border-top:1px solid rgba(80,55,25,.08);"><div style="font-size:.7rem;color:#7a6a58;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">Last message</div><div style="white-space:pre-wrap;line-height:1.55;color:#1e1810;font-size:.92rem;">"' + ePreview + '"</div></div>' : '')
          + '</div>';
        sendPromises.push(sendBrandedEmail({
          env, logTag: 'Cron-Stale-Admin',
          to: adminRecipients,
          subject: subjects[level],
          text: adminBody,
          shell: {
            preheader: 'Stale conversation \u2014 ' + level + 'h+ wait at ' + partnerName,
            kicker: 'The Bearing \u00b7 Admin',
            heading: 'Stale conversation reminder',
            intro: 'A conversation has been awaiting a reply for <strong>' + level + 'h+</strong>.',
            bodyHtml: adminStaleBlock,
            ctaUrl: replyUrl,
            ctaLabel: 'Open in admin'
          }
        }));
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

// v73at: Branded transactional email template.
//
// Every Resend send goes through sendBrandedEmail() so all emails share the
// same cream/ink/terracotta TheBearing styling and a Cormorant Garamond
// wordmark header. The function builds both an HTML body (via renderEmailShell)
// and preserves the plain-text version as a fallback for clients that don't
// render HTML.
//
// Design constraints learned the hard way for email rendering:
// - Gmail strips <style> tags, so every CSS property is inline.
// - Cormorant Garamond Google Font WILL load in Apple Mail / Outlook desktop /
//   most webmail; Gmail falls back to Georgia. The fallback chain is set so
//   it degrades gracefully \u2014 'Cormorant Garamond', Georgia, 'Times New
//   Roman', serif.
// - Max-width 560px is the sweet spot for desktop + mobile single-column.
// - Background colors don't render in dark mode in many clients, so the
//   shell is tested against both light and dark mode (colors chosen to still
//   read OK on dark).
//
// renderEmailShell({preheader, kicker, heading, intro, bodyHtml, ctaUrl,
//   ctaLabel, ctaSecondaryUrl, ctaSecondaryLabel, refLabel, unsubUrl, footerNote})
//   - preheader: small grey text shown in inbox preview before the email opens
//   - kicker: tiny terracotta uppercase tag above heading ("The Bearing" or
//     "The Bearing \u00b7 Partner" or "The Bearing \u00b7 Admin")
//   - heading: large Cormorant Garamond serif title
//   - intro: paragraph below heading
//   - bodyHtml: HTML string for the main content (already escaped)
//   - ctaUrl/ctaLabel: primary terracotta button
//   - ctaSecondaryUrl/ctaSecondaryLabel: optional secondary text link
//   - refLabel: optional small reference at the bottom (e.g. "TB-2026-1234")
//   - unsubUrl: optional unsubscribe / mute link in footer
//   - footerNote: optional short paragraph above the footer
// ── RESERVE CREDITS ──────────────────────────────────────────────────────
//
// Guests earn 10% of every confirmed Bearing booking toward a $4,000 milestone
// that unlocks a free cabin on Nour El Nil. Architecture (v74v):
//
//   • State machine per ledger entry:
//       pending  → earned    (when full balance paid AND checkout+7days passed)
//       pending  → voided    (if booking cancelled before earned)
//       earned   → used      (when guest redeems on a Nour El Nil booking)
//       earned   → expired   (24mo after the LAST earned event, no new activity)
//
//   • Storage: member:{id}:credits → JSON with { ledger: [...entries], updatedAt }
//     Balance is ALWAYS computed by summing the ledger — never stored as a
//     denormalized field. This eliminates a class of "balance drift" bugs.
//
//   • Ledger entry shape:
//       {
//         id: 'cred_...',            // unique
//         type: 'earn'|'redeem'|'adjust',
//         status: 'pending'|'earned'|'used'|'voided'|'expired',
//         amount: number (cents),    // signed: +earn, -redeem, +/-adjust
//         sourceBookingRef?: string, // booking that triggered this
//         sourceEvent?: string,      // 'deposit_paid' | 'cancellation' | 'manual'
//         sourceTotal?: number,      // total trip value this was 10% of (cents)
//         reason?: string,           // human description (esp. for admin adjusts)
//         actor?: string,            // email of admin who created (manual only)
//         createdAt: string,         // ISO
//         promotedAt?: string,       // ISO — when pending → earned
//         voidedAt?: string,         // ISO — when pending → voided
//         usedAt?: string,           // ISO — when earned → used
//         usedOnBookingRef?: string  // booking that consumed this credit
//       }
//
//   • Earn trigger: Stripe deposit-paid webhook → creditsAccrueOnDeposit().
//     Idempotent — checks for existing earn entry with same booking + event.
//
//   • Promote trigger: daily cron scans pending entries where booking is fully
//     paid AND checkout date + 7 days has passed.
//
//   • Excluded property: Nour El Nil itself (booking.slug === 'nour-el-nil').
//     We DON'T earn credits from the property you redeem against.
//
//   • Redemption: all-or-nothing at $4,000. The redeem entry stores amount=-400000
//     (cents). Excess earned balance over $4,000 stays in the account.
//
//   • Expiry: 24mo from the LAST earned entry. Pending entries don't count
//     toward extending the clock (prevents booking-and-cancel cycling).

const CREDITS_GOAL_CENTS = 400000;          // $4,000 redemption threshold
const CREDITS_RATE = 0.10;                  // 10% of trip total
const CREDITS_GRACE_DAYS = 7;               // after checkout before promote
const CREDITS_EXPIRY_MONTHS = 24;           // from last earned entry
const CREDITS_EXCLUDED_SLUGS = ['nour-el-nil'];  // properties that don't earn

function creditsKey(memberId) {
  return 'member:' + memberId + ':credits';
}

async function creditsLoadLedger(env, memberId) {
  if (!memberId) return { ledger: [], updatedAt: null };
  try {
    const raw = await env.DOSSIERS.get(creditsKey(memberId));
    if (!raw) return { ledger: [], updatedAt: null };
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.ledger)) return { ledger: [], updatedAt: null };
    return parsed;
  } catch (e) {
    console.error('[credits] load failed for', memberId, e);
    return { ledger: [], updatedAt: null };
  }
}

async function creditsSaveLedger(env, memberId, ledger) {
  if (!memberId) return;
  const payload = { ledger, updatedAt: new Date().toISOString() };
  await env.DOSSIERS.put(creditsKey(memberId), JSON.stringify(payload));
}

function creditsNewId() {
  return 'cred_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Compute the current state of an account from its ledger.
// Returns: { pendingCents, earnedCents, usedCents, voidedCents, expiredCents,
//            redeemableMilestones, expiresAt|null, lastEarnedAt|null }
function creditsComputeBalances(ledger) {
  let pendingCents = 0, earnedCents = 0, usedCents = 0;
  let voidedCents = 0, expiredCents = 0;
  let lastEarnedAt = null;
  for (const e of (ledger || [])) {
    const amt = Number(e.amount) || 0;
    if (e.status === 'pending') pendingCents += amt;
    else if (e.status === 'earned') {
      earnedCents += amt;
      if (amt > 0) {
        const at = e.promotedAt || e.createdAt;
        if (!lastEarnedAt || at > lastEarnedAt) lastEarnedAt = at;
      }
    }
    else if (e.status === 'used') usedCents += amt;
    else if (e.status === 'voided') voidedCents += amt;
    else if (e.status === 'expired') expiredCents += amt;
  }
  // available redeemable balance = sum of earned (positive minus negative)
  const availableEarnedCents = earnedCents;
  const redeemableMilestones = Math.floor(availableEarnedCents / CREDITS_GOAL_CENTS);
  let expiresAt = null;
  if (lastEarnedAt && availableEarnedCents > 0) {
    const d = new Date(lastEarnedAt);
    d.setMonth(d.getMonth() + CREDITS_EXPIRY_MONTHS);
    expiresAt = d.toISOString();
  }
  return {
    pendingCents, earnedCents: availableEarnedCents, usedCents,
    voidedCents, expiredCents,
    redeemableMilestones, expiresAt, lastEarnedAt
  };
}

// Resolve a booking's member ID. Bookings created in v74v+ store guestId
// directly. Older bookings need email→member lookup as fallback.
async function creditsResolveMemberId(env, booking) {
  if (!booking) return null;
  if (booking.guestId && typeof booking.guestId === 'string') return booking.guestId;
  // Fallback: lookup member by email
  if (!booking.email) return null;
  const emailLower = String(booking.email).toLowerCase().trim();
  if (!emailLower) return null;
  try {
    const rawIdx = await env.DOSSIERS.get('__members_index');
    if (!rawIdx) return null;
    const ids = JSON.parse(rawIdx);
    if (!Array.isArray(ids)) return null;
    // Linear scan — fine for current member counts (<10K).
    // If this grows, add a reverse index `member:email:{lc}` → id.
    for (const id of ids) {
      const memberRaw = await env.DOSSIERS.get('member:' + id);
      if (!memberRaw) continue;
      const member = JSON.parse(memberRaw);
      const emails = Array.isArray(member.emailAddresses) ? member.emailAddresses : [];
      for (const e of emails) {
        const val = typeof e === 'string' ? e : (e && e.emailAddress) || '';
        if (val && val.toLowerCase().trim() === emailLower) return id;
      }
      // Also check `email` field directly
      if (member.email && String(member.email).toLowerCase().trim() === emailLower) return id;
    }
  } catch (e) {
    console.error('[credits] resolve member by email failed:', e);
  }
  return null;
}

// Determine whether a booking is eligible to earn credits.
function creditsEligibleBooking(booking) {
  if (!booking) return false;
  if (!booking.slug) return false;
  if (CREDITS_EXCLUDED_SLUGS.indexOf(String(booking.slug).toLowerCase()) !== -1) return false;
  const status = String(booking.status || '').toLowerCase();
  if (status === 'cancelled') return false;
  return true;
}

// Accrue PENDING credits when deposit is paid. Idempotent: if an earn entry
// already exists for this booking + deposit_paid event, this is a no-op.
//
// Returns: { ok, skipped?: reason, entryId?, amountCents? }
async function creditsAccrueOnDeposit(env, booking) {
  if (!creditsEligibleBooking(booking)) {
    return { ok: false, skipped: 'ineligible_booking' };
  }
  // Total to base credits on: prefer confirmed total, fall back to total
  const totalDollars =
    Number(booking.confirmed_total_amount) ||
    Number(booking.total_amount) ||
    Number(booking.totalAmount) || 0;
  if (totalDollars <= 0) return { ok: false, skipped: 'zero_total' };

  const memberId = await creditsResolveMemberId(env, booking);
  if (!memberId) return { ok: false, skipped: 'no_member' };

  const state = await creditsLoadLedger(env, memberId);
  // Idempotency check
  const existing = state.ledger.find(e =>
    e.type === 'earn' &&
    e.sourceBookingRef === booking.ref &&
    e.sourceEvent === 'deposit_paid'
  );
  if (existing) return { ok: true, skipped: 'already_accrued', entryId: existing.id };

  const totalCents = Math.round(totalDollars * 100);
  const creditCents = Math.round(totalCents * CREDITS_RATE);

  const entry = {
    id: creditsNewId(),
    type: 'earn',
    status: 'pending',
    amount: creditCents,
    sourceBookingRef: booking.ref,
    sourceEvent: 'deposit_paid',
    sourceTotal: totalCents,
    createdAt: new Date().toISOString(),
  };
  state.ledger.push(entry);
  await creditsSaveLedger(env, memberId, state.ledger);
  return { ok: true, entryId: entry.id, amountCents: creditCents, memberId };
}

// Promote pending credits to earned when:
//   - full balance is paid (booking.paymentStatus === 'paid')
//   - AND checkout date + grace days has passed
async function creditsPromotePending(env, booking) {
  if (!creditsEligibleBooking(booking)) return { ok: false, skipped: 'ineligible' };
  if (String(booking.paymentStatus || '').toLowerCase() !== 'paid') {
    return { ok: false, skipped: 'not_fully_paid' };
  }
  const departure = booking.departure || booking.confirmed_balance_due_date;
  if (!departure) return { ok: false, skipped: 'no_departure' };
  const depDate = new Date(departure);
  if (isNaN(depDate.getTime())) return { ok: false, skipped: 'bad_departure_date' };
  const promoteAfter = new Date(depDate);
  promoteAfter.setDate(promoteAfter.getDate() + CREDITS_GRACE_DAYS);
  if (new Date() < promoteAfter) return { ok: false, skipped: 'grace_not_elapsed' };

  const memberId = await creditsResolveMemberId(env, booking);
  if (!memberId) return { ok: false, skipped: 'no_member' };

  const state = await creditsLoadLedger(env, memberId);
  const pending = state.ledger.filter(e =>
    e.type === 'earn' &&
    e.status === 'pending' &&
    e.sourceBookingRef === booking.ref
  );
  if (!pending.length) return { ok: false, skipped: 'no_pending_for_booking' };
  const now = new Date().toISOString();
  for (const e of pending) {
    e.status = 'earned';
    e.promotedAt = now;
  }
  await creditsSaveLedger(env, memberId, state.ledger);
  return { ok: true, promoted: pending.length };
}

// Void credits when a booking is cancelled. Voids any pending OR earned entries
// from that booking (earned-then-cancelled is rare but possible — e.g. refund
// after a partial stay). If credits from this booking were already USED, that
// requires a manual admin adjustment (admin gets a flag).
async function creditsVoidOnCancellation(env, booking) {
  const memberId = await creditsResolveMemberId(env, booking);
  if (!memberId) return { ok: false, skipped: 'no_member' };
  const state = await creditsLoadLedger(env, memberId);
  let voided = 0;
  let alreadyUsed = 0;
  const now = new Date().toISOString();
  for (const e of state.ledger) {
    if (e.sourceBookingRef !== booking.ref) continue;
    if (e.type !== 'earn') continue;
    if (e.status === 'pending' || e.status === 'earned') {
      e.status = 'voided';
      e.voidedAt = now;
      e.voidReason = 'booking_cancelled';
      voided++;
    } else if (e.status === 'used') {
      // Credits from this booking were already used — admin intervention needed.
      alreadyUsed++;
    }
  }
  if (voided > 0 || alreadyUsed > 0) {
    await creditsSaveLedger(env, memberId, state.ledger);
  }
  return { ok: true, voided, alreadyUsed, memberId };
}

// Apply a $4,000 redemption against a booking. All-or-nothing at the milestone.
// Caller must have already verified the booking is Nour El Nil and the guest
// approved the redemption at offer acceptance.
async function creditsRedeem(env, memberId, redemptionBookingRef) {
  if (!memberId) return { ok: false, error: 'no_member' };
  if (!redemptionBookingRef) return { ok: false, error: 'no_booking_ref' };

  const state = await creditsLoadLedger(env, memberId);
  const balances = creditsComputeBalances(state.ledger);
  if (balances.earnedCents < CREDITS_GOAL_CENTS) {
    return { ok: false, error: 'insufficient_balance', earnedCents: balances.earnedCents };
  }

  // Idempotency: if a redeem entry already exists for this booking, skip.
  const existing = state.ledger.find(e =>
    e.type === 'redeem' && e.usedOnBookingRef === redemptionBookingRef
  );
  if (existing) return { ok: true, skipped: 'already_redeemed', entryId: existing.id };

  const entry = {
    id: creditsNewId(),
    type: 'redeem',
    status: 'used',
    amount: -CREDITS_GOAL_CENTS,
    usedOnBookingRef: redemptionBookingRef,
    usedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  state.ledger.push(entry);
  await creditsSaveLedger(env, memberId, state.ledger);
  return { ok: true, entryId: entry.id, amountCents: CREDITS_GOAL_CENTS };
}

// Reverse a redemption (e.g. Nour El Nil booking cancelled before stay).
// Returns credits to earned status by creating a positive "earn" entry tied
// to the original redemption.
async function creditsReverseRedemption(env, memberId, originalBookingRef) {
  if (!memberId || !originalBookingRef) return { ok: false };
  const state = await creditsLoadLedger(env, memberId);
  const redeem = state.ledger.find(e =>
    e.type === 'redeem' &&
    e.status === 'used' &&
    e.usedOnBookingRef === originalBookingRef
  );
  if (!redeem) return { ok: false, error: 'no_redemption_found' };
  // Idempotency: don't reverse twice
  if (redeem.reversedAt) return { ok: true, skipped: 'already_reversed' };
  redeem.status = 'reversed';
  redeem.reversedAt = new Date().toISOString();
  // Add an equal positive earn entry so balance is restored.
  state.ledger.push({
    id: creditsNewId(),
    type: 'adjust',
    status: 'earned',
    amount: CREDITS_GOAL_CENTS,
    reason: 'Redemption reversed — booking ' + originalBookingRef + ' was cancelled',
    sourceEvent: 'redemption_reversed',
    sourceBookingRef: originalBookingRef,
    createdAt: new Date().toISOString(),
    promotedAt: new Date().toISOString(),
  });
  await creditsSaveLedger(env, memberId, state.ledger);
  return { ok: true };
}

// Expire credits 24 months after the last earned event, if no new activity.
async function creditsExpireStale(env, memberId) {
  if (!memberId) return { ok: false };
  const state = await creditsLoadLedger(env, memberId);
  const bal = creditsComputeBalances(state.ledger);
  if (!bal.expiresAt) return { ok: true, skipped: 'no_expiry' };
  if (new Date() < new Date(bal.expiresAt)) return { ok: true, skipped: 'not_expired' };

  const now = new Date().toISOString();
  let expiredCount = 0;
  for (const e of state.ledger) {
    if (e.status === 'pending' || e.status === 'earned') {
      e.status = 'expired';
      e.expiredAt = now;
      expiredCount++;
    }
  }
  if (expiredCount > 0) {
    await creditsSaveLedger(env, memberId, state.ledger);
  }
  return { ok: true, expired: expiredCount };
}


// Daily scan: promote pending → earned where conditions are met, and expire
// stale credits past 24mo. Called by /api/credits/admin/run-promotion AND
// by the scheduled() cron handler.
async function creditsRunPromotionScan(env) {
  if (!env.DOSSIERS) return { ok: false, error: 'KV not bound' };
  const startedAt = new Date().toISOString();
  let scanned = 0, promoted = 0, expired = 0, errors = 0;
  try {
    const rawIdx = await env.DOSSIERS.get('__members_index');
    const ids = rawIdx ? JSON.parse(rawIdx) : [];
    if (!Array.isArray(ids)) return { ok: true, scanned: 0, promoted: 0, expired: 0, errors: 0 };
    for (const memberId of ids) {
      try {
        const state = await creditsLoadLedger(env, memberId);
        if (!state.ledger.length) continue;
        scanned++;
        // Promote pending entries whose source booking is paid+grace-elapsed.
        const pendingEntries = state.ledger.filter(function(e) {
          return e.type === 'earn' && e.status === 'pending' && e.sourceBookingRef;
        });
        for (const entry of pendingEntries) {
          try {
            const bookingRaw = await env.DOSSIERS.get('booking:' + entry.sourceBookingRef);
            if (!bookingRaw) continue;
            const booking = JSON.parse(bookingRaw);
            const res = await creditsPromotePending(env, booking);
            if (res && res.ok && res.promoted) promoted += res.promoted;
          } catch (e) { errors++; }
        }
        // Expire stale credits (24mo from last earned).
        try {
          const res = await creditsExpireStale(env, memberId);
          if (res && res.ok && res.expired) expired += res.expired;
        } catch (e) { errors++; }
      } catch (e) {
        errors++;
        console.error('[credits-scan] member ' + memberId + ' failed:', e);
      }
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
  const completedAt = new Date().toISOString();
  const summary = { ok: true, startedAt, completedAt, scanned, promoted, expired, errors };
  // Persist last-run state for admin visibility
  try { await env.DOSSIERS.put('__credits:last_run', JSON.stringify(summary)); } catch(e) {}
  return summary;
}

// v74w: independent FM promotion pass. Scans all members; for any with
// foundingMember.status === 'pending', check if they have a completed trip
// and promote to awarded if so. Independent of credits because Nour El Nil
// bookings (excluded from earning credits) still count toward FM.
async function foundingMemberRunPromotionScan(env) {
  if (!env.DOSSIERS) return { ok: false, error: 'KV not bound' };
  const startedAt = new Date().toISOString();
  let scanned = 0, promoted = 0, errors = 0;
  try {
    const rawIdx = await env.DOSSIERS.get('__members_index');
    const ids = rawIdx ? JSON.parse(rawIdx) : [];
    if (!Array.isArray(ids)) return { ok: true, scanned: 0, promoted: 0, errors: 0 };
    for (const memberId of ids) {
      try {
        const member = await fmLoadMember(env, memberId);
        if (!member || !member.foundingMember) continue;
        if (member.foundingMember.status !== 'pending') continue;
        scanned++;
        const res = await foundingMemberPromote(env, memberId);
        if (res && res.ok && res.number) promoted++;
      } catch (e) {
        errors++;
        console.error('[fm-scan] member ' + memberId + ' failed:', e);
      }
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
  const completedAt = new Date().toISOString();
  const summary = { ok: true, startedAt, completedAt, scanned, promoted, errors };
  try { await env.DOSSIERS.put('__founding_member:last_run', JSON.stringify(summary)); } catch(e) {}
  return summary;
}


// ── FOUNDING MEMBER ──────────────────────────────────────────────────────
//
// v74w. Brand-tier loyalty: first 1,000 guests to complete a Bearing booking
// earn permanent Founding Member status with a member number.
//
//   State machine per member:
//     pending  → awarded   (when any trip completes — see creditsRunPromotionScan)
//     pending  → voided    (when the reserving booking is cancelled before completion)
//     awarded                (terminal — never revoked by automation)
//
//   Storage:
//     member:{id} now has optional `foundingMember` field
//     __founding_member:state — single counter document
//
//   Counter shape:
//     { nextNumber, reservedCount, awardedCount, voidedNumbers: [...], cap, updatedAt }
//
//   Number assignment:
//     Smallest recycled number first; fall back to nextNumber++.
//     Recycling keeps the visible range compact when early bookings cancel.
//
//   Cap:
//     Soft-enforced via FOUNDING_MEMBER_CAP constant. Once reservedCount +
//     awardedCount >= cap, new reservations fail (no number assigned, no error
//     thrown — just no FM status awarded). Bump the constant to raise the cap.
//
//   Once-and-done:
//     A member earns FM exactly once. Subsequent bookings don't re-trigger.
//     If the FM-reserving booking is cancelled and another confirmed booking
//     exists, the void hook re-reserves FM against the next booking (with a
//     new number — old one is recycled).
//
//   No retroactive grants for pre-v74w bookings. Admin can manually grant.

const FOUNDING_MEMBER_CAP = 1000;

async function fmLoadCounter(env) {
  try {
    const raw = await env.DOSSIERS.get('__founding_member:state');
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error('[fm] counter load failed:', e);
  }
  return {
    nextNumber: 1,
    reservedCount: 0,
    awardedCount: 0,
    voidedNumbers: [],
    cap: FOUNDING_MEMBER_CAP,
    updatedAt: null,
  };
}

async function fmSaveCounter(env, counter) {
  counter.updatedAt = new Date().toISOString();
  await env.DOSSIERS.put('__founding_member:state', JSON.stringify(counter));
}

async function fmLoadMember(env, memberId) {
  if (!memberId) return null;
  try {
    const raw = await env.DOSSIERS.get('member:' + memberId);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function fmSaveMember(env, memberId, member) {
  await env.DOSSIERS.put('member:' + memberId, JSON.stringify(member));
}

// Pick the next available number. Prefer recycled numbers (smallest first)
// before consuming nextNumber. Returns the number AND mutates the counter
// (in-memory only — caller must save).
function fmAllocateNumber(counter) {
  if (counter.voidedNumbers && counter.voidedNumbers.length > 0) {
    counter.voidedNumbers.sort(function(a, b) { return a - b; });
    return counter.voidedNumbers.shift();
  }
  const n = counter.nextNumber;
  counter.nextNumber = n + 1;
  return n;
}

// Reserve FM status for the member who owns this booking. Idempotent: if the
// member already has FM status (any state), no-op. If the cap is reached, no-op
// with `skipped: 'cap_reached'`. Otherwise allocates a number and sets pending.
async function foundingMemberReserve(env, booking) {
  if (!booking) return { ok: false, skipped: 'no_booking' };
  const status = String(booking.status || '').toLowerCase();
  if (status === 'cancelled') return { ok: false, skipped: 'cancelled_booking' };

  const memberId = await creditsResolveMemberId(env, booking);
  if (!memberId) return { ok: false, skipped: 'no_member' };

  const member = await fmLoadMember(env, memberId);
  if (!member) return { ok: false, skipped: 'no_member_record' };
  if (member.foundingMember && member.foundingMember.status && member.foundingMember.status !== 'voided') {
    // Already enrolled (pending or awarded). Idempotent no-op.
    return { ok: true, skipped: 'already_enrolled', number: member.foundingMember.number, status: member.foundingMember.status };
  }

  const counter = await fmLoadCounter(env);
  const totalUsed = (counter.reservedCount || 0) + (counter.awardedCount || 0);
  if (totalUsed >= counter.cap) {
    return { ok: false, skipped: 'cap_reached', cap: counter.cap };
  }

  const number = fmAllocateNumber(counter);
  counter.reservedCount = (counter.reservedCount || 0) + 1;

  member.foundingMember = {
    number,
    status: 'pending',
    reservedAt: new Date().toISOString(),
    reservedForBookingRef: booking.ref || '',
    awardedAt: null,
    voidedAt: null,
    voidedReason: null,
  };

  await fmSaveMember(env, memberId, member);
  await fmSaveCounter(env, counter);
  console.log('[fm] reserved #' + number + ' (pending) for member ' + memberId + ' on booking ' + (booking.ref || '?'));
  return { ok: true, memberId, number, status: 'pending' };
}

// Void FM status if it was reserved for this specific booking AND is still
// pending. If awarded, no action (a different trip already completed and
// secured them). If the void leaves them with another confirmed booking we
// could re-reserve from, do so (so they still get FM, possibly with a new
// number).
async function foundingMemberVoidIfPendingForBooking(env, booking) {
  if (!booking) return { ok: false, skipped: 'no_booking' };
  const memberId = await creditsResolveMemberId(env, booking);
  if (!memberId) return { ok: false, skipped: 'no_member' };

  const member = await fmLoadMember(env, memberId);
  if (!member || !member.foundingMember) return { ok: true, skipped: 'no_fm' };
  const fm = member.foundingMember;
  if (fm.status !== 'pending') return { ok: true, skipped: 'not_pending' };
  if (fm.reservedForBookingRef !== booking.ref) {
    // Pending FM was reserved by a DIFFERENT booking — leave it alone.
    return { ok: true, skipped: 'reserved_by_other_booking' };
  }

  const counter = await fmLoadCounter(env);
  const releasedNumber = fm.number;

  fm.status = 'voided';
  fm.voidedAt = new Date().toISOString();
  fm.voidedReason = 'reserving_booking_cancelled';
  counter.reservedCount = Math.max(0, (counter.reservedCount || 0) - 1);
  counter.voidedNumbers = counter.voidedNumbers || [];
  counter.voidedNumbers.push(releasedNumber);

  await fmSaveMember(env, memberId, member);
  await fmSaveCounter(env, counter);
  console.log('[fm] voided #' + releasedNumber + ' for member ' + memberId + ' (booking ' + booking.ref + ' cancelled)');

  // Try to re-reserve against another confirmed booking, if any.
  try {
    const bIdxRaw = await env.DOSSIERS.get('__bookings_index');
    if (bIdxRaw) {
      const refs = JSON.parse(bIdxRaw) || [];
      for (const ref of refs) {
        if (ref === booking.ref) continue;
        const bRaw = await env.DOSSIERS.get('booking:' + ref);
        if (!bRaw) continue;
        const b = JSON.parse(bRaw);
        if (String(b.status || '').toLowerCase() !== 'confirmed') continue;
        // Match by guestId or email
        let isSameMember = false;
        if (b.guestId && b.guestId === memberId) isSameMember = true;
        else if (b.email && member.email && String(b.email).toLowerCase() === String(member.email).toLowerCase()) isSameMember = true;
        else if (b.email && Array.isArray(member.emailAddresses)) {
          for (const e of member.emailAddresses) {
            const val = typeof e === 'string' ? e : (e && e.emailAddress) || '';
            if (val && val.toLowerCase() === String(b.email).toLowerCase()) { isSameMember = true; break; }
          }
        }
        if (!isSameMember) continue;
        // Re-reserve. Note: foundingMemberReserve checks `member.foundingMember.status`
        // — we just set it to 'voided' above, so reserve() will allocate a new number.
        const reRes = await foundingMemberReserve(env, b);
        if (reRes && reRes.ok && !reRes.skipped) {
          console.log('[fm] re-reserved #' + reRes.number + ' for member ' + memberId + ' against backup booking ' + ref);
        }
        break;
      }
    }
  } catch (e) {
    console.error('[fm] re-reserve scan failed:', e && e.message);
  }

  return { ok: true, voidedNumber: releasedNumber };
}

// Promote pending → awarded for any member with FM status who has completed
// at least one trip (booking.paymentStatus='paid' AND checkout+7days passed).
// Called from creditsRunPromotionScan in the same hourly cron pass.
async function foundingMemberPromote(env, memberId) {
  if (!memberId) return { ok: false };
  const member = await fmLoadMember(env, memberId);
  if (!member || !member.foundingMember) return { ok: true, skipped: 'no_fm' };
  if (member.foundingMember.status !== 'pending') return { ok: true, skipped: 'not_pending' };

  // Find any completed trip for this member
  const bIdxRaw = await env.DOSSIERS.get('__bookings_index');
  if (!bIdxRaw) return { ok: true, skipped: 'no_bookings' };
  const refs = JSON.parse(bIdxRaw) || [];
  let foundCompleted = false;
  const now = Date.now();
  const graceMs = 7 * 24 * 60 * 60 * 1000;
  for (const ref of refs) {
    const bRaw = await env.DOSSIERS.get('booking:' + ref);
    if (!bRaw) continue;
    const b = JSON.parse(bRaw);
    // Match member
    let isSameMember = false;
    if (b.guestId && b.guestId === memberId) isSameMember = true;
    else if (b.email && member.email && String(b.email).toLowerCase() === String(member.email).toLowerCase()) isSameMember = true;
    if (!isSameMember) continue;
    if (String(b.paymentStatus || '').toLowerCase() !== 'paid') continue;
    const dep = b.departure || b.confirmed_balance_due_date;
    if (!dep) continue;
    const depMs = new Date(dep).getTime();
    if (isNaN(depMs)) continue;
    if ((now - depMs) < graceMs) continue;
    foundCompleted = true;
    break;
  }
  if (!foundCompleted) return { ok: true, skipped: 'no_completed_trip' };

  const counter = await fmLoadCounter(env);
  member.foundingMember.status = 'awarded';
  member.foundingMember.awardedAt = new Date().toISOString();
  counter.reservedCount = Math.max(0, (counter.reservedCount || 0) - 1);
  counter.awardedCount = (counter.awardedCount || 0) + 1;

  await fmSaveMember(env, memberId, member);
  await fmSaveCounter(env, counter);
  console.log('[fm] promoted #' + member.foundingMember.number + ' to awarded for member ' + memberId);
  return { ok: true, number: member.foundingMember.number };
}

// Admin manual grant — assigns FM directly to a member with status=awarded.
// Used for comp grants, post-launch goodwill, etc.
async function foundingMemberAdminGrant(env, memberId, actor, reason) {
  if (!memberId) return { ok: false, error: 'no_member' };
  const member = await fmLoadMember(env, memberId);
  if (!member) return { ok: false, error: 'member_not_found' };
  if (member.foundingMember && member.foundingMember.status === 'awarded') {
    return { ok: true, skipped: 'already_awarded', number: member.foundingMember.number };
  }

  const counter = await fmLoadCounter(env);
  const totalUsed = (counter.reservedCount || 0) + (counter.awardedCount || 0);
  if (totalUsed >= counter.cap) {
    return { ok: false, error: 'cap_reached', cap: counter.cap };
  }

  let number;
  if (member.foundingMember && member.foundingMember.status === 'pending') {
    // Promote existing pending to awarded
    number = member.foundingMember.number;
    counter.reservedCount = Math.max(0, (counter.reservedCount || 0) - 1);
  } else {
    number = fmAllocateNumber(counter);
  }
  counter.awardedCount = (counter.awardedCount || 0) + 1;

  member.foundingMember = {
    number,
    status: 'awarded',
    reservedAt: (member.foundingMember && member.foundingMember.reservedAt) || new Date().toISOString(),
    reservedForBookingRef: (member.foundingMember && member.foundingMember.reservedForBookingRef) || '',
    awardedAt: new Date().toISOString(),
    awardedBy: actor || 'admin',
    awardedReason: reason || 'manual grant',
    voidedAt: null,
    voidedReason: null,
  };
  await fmSaveMember(env, memberId, member);
  await fmSaveCounter(env, counter);
  console.log('[fm] admin granted #' + number + ' to member ' + memberId + ' (by ' + actor + ': ' + reason + ')');
  return { ok: true, number, status: 'awarded' };
}

// Admin manual revoke — removes FM status. Recycles the number.
async function foundingMemberAdminRevoke(env, memberId, actor, reason) {
  if (!memberId) return { ok: false, error: 'no_member' };
  const member = await fmLoadMember(env, memberId);
  if (!member || !member.foundingMember) return { ok: false, error: 'no_fm_to_revoke' };
  const fm = member.foundingMember;
  const releasedNumber = fm.number;
  const counter = await fmLoadCounter(env);

  if (fm.status === 'pending') counter.reservedCount = Math.max(0, (counter.reservedCount || 0) - 1);
  else if (fm.status === 'awarded') counter.awardedCount = Math.max(0, (counter.awardedCount || 0) - 1);

  fm.status = 'voided';
  fm.voidedAt = new Date().toISOString();
  fm.voidedReason = (reason || 'admin revoke') + ' (by ' + (actor || 'admin') + ')';
  counter.voidedNumbers = counter.voidedNumbers || [];
  counter.voidedNumbers.push(releasedNumber);

  await fmSaveMember(env, memberId, member);
  await fmSaveCounter(env, counter);
  return { ok: true, revokedNumber: releasedNumber };
}


function escapeEmailHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderEmailShell(opts) {
  opts = opts || {};
  const preheader = opts.preheader || '';
  const kicker = opts.kicker || 'The Bearing';
  const heading = opts.heading || '';
  const intro = opts.intro || '';
  const bodyHtml = opts.bodyHtml || '';
  const ctaUrl = opts.ctaUrl || '';
  const ctaLabel = opts.ctaLabel || '';
  const ctaSecondaryUrl = opts.ctaSecondaryUrl || '';
  const ctaSecondaryLabel = opts.ctaSecondaryLabel || '';
  const refLabel = opts.refLabel || '';
  const unsubUrl = opts.unsubUrl || '';
  const footerNote = opts.footerNote || '';

  // Hidden preheader sits before the visible content so inbox preview shows it.
  const preheaderBlock = preheader
    ? '<div style="display:none;font-size:1px;color:#faf7f1;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">' + escapeEmailHtml(preheader) + '</div>'
    : '';

  const introBlock = intro
    ? '<p style="font-size:.96rem;line-height:1.6;color:#3a3128;margin:0 0 22px;">' + intro + '</p>'
    : '';

  const ctaBlock = ctaUrl && ctaLabel
    ? '<div style="margin:6px 0 22px;">'
        + '<a href="' + escapeEmailHtml(ctaUrl) + '" style="display:inline-block;background:#b05830;color:#ffffff;padding:13px 22px;border-radius:9px;text-decoration:none;font-weight:600;font-size:.92rem;letter-spacing:.01em;box-shadow:0 2px 8px rgba(176,88,48,.25);">' + escapeEmailHtml(ctaLabel) + ' &rarr;</a>'
        + (ctaSecondaryUrl && ctaSecondaryLabel
            ? '<a href="' + escapeEmailHtml(ctaSecondaryUrl) + '" style="display:inline-block;margin-left:10px;color:#7a6a58;padding:13px 14px;text-decoration:underline;font-size:.88rem;">' + escapeEmailHtml(ctaSecondaryLabel) + '</a>'
            : '')
      + '</div>'
    : '';

  const footerNoteBlock = footerNote
    ? '<p style="color:#7a6a58;font-size:.82rem;line-height:1.55;margin:18px 0 0;">' + footerNote + '</p>'
    : '';

  const refBlock = refLabel
    ? '<p style="color:#9a8e80;font-size:.78rem;margin:24px 0 0;border-top:1px solid rgba(80,55,25,.08);padding-top:14px;">Reference: <code style="font-family:\'JetBrains Mono\',Consolas,monospace;font-size:.78rem;">' + escapeEmailHtml(refLabel) + '</code></p>'
    : '';

  const unsubBlock = unsubUrl
    ? '<p style="color:#9a8e80;font-size:.74rem;margin:18px 0 0;line-height:1.5;"><a href="' + escapeEmailHtml(unsubUrl) + '" style="color:#9a8e80;text-decoration:underline;">Mute email notifications for this conversation</a></p>'
    : '';

  return '<!doctype html><html><head>'
    + '<meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>The Bearing</title>'
    + '</head>'
    + '<body style="margin:0;padding:0;background:#f3eee3;font-family:Geist,-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#1e1810;">'
    + preheaderBlock
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3eee3;padding:32px 16px;">'
    + '<tr><td align="center">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;width:100%;background:#faf7f1;border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(30,24,16,.04);">'
    + '<tr><td style="padding:36px 32px 8px;text-align:center;border-bottom:1px solid rgba(80,55,25,.08);">'
    + '<div style="font-family:\'Cormorant Garamond\',Georgia,\'Times New Roman\',serif;font-size:1.7rem;font-weight:500;letter-spacing:.32em;color:#1e1810;text-transform:uppercase;">The Bearing</div>'
    + '<div style="font-family:Geist,system-ui,sans-serif;font-size:.62rem;letter-spacing:.18em;text-transform:uppercase;color:#9a7230;margin-top:6px;">Curated travel</div>'
    + '</td></tr>'
    + '<tr><td style="padding:32px 32px 36px;">'
    + (kicker ? '<div style="font-family:Geist,system-ui,sans-serif;font-size:.62rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#b05830;margin-bottom:10px;">' + escapeEmailHtml(kicker) + '</div>' : '')
    + (heading ? '<h1 style="font-family:\'Instrument Serif\',\'Cormorant Garamond\',Georgia,serif;font-size:1.7rem;line-height:1.2;margin:0 0 14px;font-weight:400;color:#1e1810;">' + heading + '</h1>' : '')
    + introBlock
    + bodyHtml
    + ctaBlock
    + footerNoteBlock
    + refBlock
    + unsubBlock
    + '</td></tr>'
    + '<tr><td style="padding:18px 32px 28px;text-align:center;background:#f3eee3;border-top:1px solid rgba(80,55,25,.08);">'
    + '<div style="font-family:\'Cormorant Garamond\',Georgia,serif;font-size:.92rem;color:#5a4a38;letter-spacing:.04em;">thebearing.io</div>'
    + '<div style="font-family:Geist,system-ui,sans-serif;font-size:.72rem;color:#9a8e80;margin-top:6px;">Questions? <a href="mailto:admin@thebearing.io" style="color:#9a8e80;text-decoration:underline;">admin@thebearing.io</a></div>'
    + '</td></tr>'
    + '</table>'
    + '</td></tr>'
    + '</table>'
    + '</body></html>';
}

// sendBrandedEmail \u2014 thin wrapper around the Resend /emails endpoint that
// guarantees branded HTML + plain-text are both included. Every email send in
// this worker should go through this function so the template stays uniform.
//
// opts: {
//   env,                  // worker env (for RESEND_API_KEY)
//   to,                   // string | string[]  recipient(s)
//   subject,              // string
//   replyTo,              // optional string \u2014 commonly reply+{convId}@replies.thebearing.io
//   text,                 // plain-text fallback (REQUIRED)
//   shell,                // renderEmailShell opts (without bodyHtml/heading already in opts)
//   from,                 // optional override; defaults to 'The Bearing <bookings@thebearing.io>'
//   logTag,               // optional string for the error log line
// }
//
// Returns: the fetch response, or null if RESEND_API_KEY is missing.
async function sendBrandedEmail(opts) {
  const env = opts && opts.env;
  if (!env || !env.RESEND_API_KEY) return null;
  const tag = opts.logTag || 'Email';
  try {
    const html = renderEmailShell(opts.shell || {});
    const payload = {
      from: opts.from || 'The Bearing <bookings@thebearing.io>',
      to: opts.to,
      subject: opts.subject,
      text: opts.text || '',
      html: html,
    };
    if (opts.replyTo) payload.reply_to = opts.replyTo;
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      let bodyText = ''; try { bodyText = await resp.text(); } catch(_) {}
      console.error('[' + tag + '] Resend ' + resp.status + ': ' + bodyText.slice(0, 240));
    }
    return resp;
  } catch (e) {
    console.error('[' + tag + '] send error: ' + (e && e.message));
    return null;
  }
}

const BASELINE_NOTIFICATION_RECIPIENT = 'admin@thebearing.io';

// v73al: transition default for partner notifications until each property
// has real per-property partner_emails set on its record. Used as a fallback
// only when property.partner_emails is missing/empty. To remove this fallback:
// (1) set partner_emails on every property record in admin-property-editor,
// (2) delete this constant and the fallback branch in loadPartnerRecipients.
// Until then, missing partner_emails routes here so we don't lose notifications.
// v73an: lowercased to match the lowercased fromEmail used in inbound role
// inference. Was 'NourElNilTest213@gmail.com' \u2014 inbound check did
// partnerList.indexOf(fromEmail.toLowerCase()) which never matched, so partner
// replies were misclassified as guest messages. Resend ignores case on the
// To: header so outbound still delivers to the inbox.
const PARTNER_EMAIL_TRANSITION_DEFAULT = 'nourelniltest213@gmail.com';

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

// v73al: Resolve the partner notification recipients for a given property slug.
// Reads `partner_emails` array from the property record (set in admin-property-
// editor). Falls back to the transition default if the field is missing/empty
// so we don't silently lose notifications during the migration.
//
// Returns: array of lowercased emails, deduped. Never empty.
// Side effects: logs a console.warn when the fallback is used, so we can find
// properties that still need their partner_emails set.
async function loadPartnerRecipients(slug, env) {
  if (!env.DOSSIERS || !slug) return [PARTNER_EMAIL_TRANSITION_DEFAULT];
  try {
    const raw = await env.DOSSIERS.get(slug + ':property');
    if (!raw) {
      console.warn('[Partner email] property record not found for slug "' + slug + '" \u2014 using transition default');
      return [PARTNER_EMAIL_TRANSITION_DEFAULT];
    }
    const prop = JSON.parse(raw);
    const list = Array.isArray(prop && prop.partner_emails) ? prop.partner_emails : [];
    const seen = {}; const out = [];
    list.forEach(function(e) {
      const lc = String(e || '').toLowerCase().trim();
      if (lc && !seen[lc]) { seen[lc] = 1; out.push(lc); }
    });
    if (out.length === 0) {
      console.warn('[Partner email] partner_emails empty for slug "' + slug + '" \u2014 using transition default. Set partner_emails in admin-property-editor.');
      return [PARTNER_EMAIL_TRANSITION_DEFAULT];
    }
    return out;
  } catch(e) {
    console.error('[Partner email] load error for slug "' + slug + '":', e.message);
    return [PARTNER_EMAIL_TRANSITION_DEFAULT];
  }
}

// v73as: partner notification preferences \u2014 Part B of partner emails.
// Three precedence layers (most specific wins):
//   1. Per-conversation event mute  \u2014 conv.notifyPartnerEvents[event] === false
//      ALSO honors the existing master mute: conv.notifyPartner === false suppresses all
//   2. Per-property universal       \u2014 partner-notif:{slug} KV record
//      { universalMute: bool, mutedEvents: ['new_enquiry', ...] }
//   3. Default                       \u2014 send
//
// Event types (6 total):
//   new_enquiry, guest_reply, deposit_paid, offer_declined, change_request, stale_reminder
//
// Edited from pp-notifications.html (per-property universal) and from the
// pp-conversations thread header (per-conv master) or future per-event UI.

const PARTNER_NOTIF_EVENTS = [
  'new_enquiry',
  'guest_reply',
  'deposit_paid',
  'offer_declined',
  'change_request',
  'stale_reminder'
];

async function loadPartnerNotifSettings(slug, env) {
  // Returns { universalMute, mutedEvents } with defaults if not set.
  // Never throws; falls back to { universalMute:false, mutedEvents:[] } on error.
  if (!env.DOSSIERS || !slug) return { universalMute: false, mutedEvents: [] };
  try {
    const raw = await env.DOSSIERS.get('partner-notif:' + slug);
    if (!raw) return { universalMute: false, mutedEvents: [] };
    const obj = JSON.parse(raw);
    return {
      universalMute: !!(obj && obj.universalMute),
      mutedEvents: Array.isArray(obj && obj.mutedEvents) ? obj.mutedEvents : []
    };
  } catch(e) {
    console.error('[Partner notif] load error for slug "' + slug + '":', e.message);
    return { universalMute: false, mutedEvents: [] };
  }
}

async function shouldSendPartnerEmail(eventType, conv, slug, env) {
  // Layer 1a: existing master mute on the conversation (notifyPartner === false)
  if (conv && conv.notifyPartner === false) return false;
  // Layer 1b: per-event mute on the conversation
  if (conv && conv.notifyPartnerEvents && conv.notifyPartnerEvents[eventType] === false) {
    return false;
  }
  // Layer 2: per-property universal
  const settings = await loadPartnerNotifSettings(slug, env);
  if (settings.universalMute) return false;
  if (settings.mutedEvents.indexOf(eventType) !== -1) return false;
  // Layer 3: default = send
  return true;
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
    let adminLoop = 0; // v74b: count of conversations with active-loop admin-unread
    const guests = {};
    const props = {};
    const propsLoop = {}; // v74b: per-property partner-loop-unread (mirrors props)
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
      // v74b: roll loop-unread into the sidebar count. Loop messages count
      // as conversations-needing-attention so the partner/admin notice from
      // anywhere in the app. We track these in separate fields so the client
      // can style the badge differently (terracotta hint) when loop activity
      // is included.
      try {
        const loopRaw = await env.DOSSIERS.get('conversation:' + id + ':loop');
        if (loopRaw) {
          const loop = JSON.parse(loopRaw);
          if (loop.active) {
            if ((loop.unreadAdmin || 0) > 0) adminLoop++;
            if ((loop.unreadPartner || 0) > 0 && c.propertySlug) {
              propsLoop[c.propertySlug] = (propsLoop[c.propertySlug] || 0) + 1;
            }
          }
        }
      } catch(_) { /* loop key missing or malformed — ignore */ }
    }
    await env.DOSSIERS.put('__unread_counters', JSON.stringify({
      admin, guests, props,
      adminLoop, propsLoop, // v74b
    }), { expirationTtl: 86400 });
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
// ════════════════════════════════════════════════════════════════════
// v74k: confirmAmendmentPayment — shared helper called by both the
// Stripe webhook (checkout.session.completed) and /api/checkout/sync-payment.
// Mirrors how the deposit-payment flow shares logic between webhook and
// sync. The function is idempotent: if booking.stripeAmendmentSessions
// already contains this sessionId, it returns "already-processed" without
// mutating anything. Whichever caller fires first wins.
// ════════════════════════════════════════════════════════════════════
async function confirmAmendmentPayment(env, params) {
  const { amendmentId, bookingRef, sessionId, amountPaid } = params;

  if (!amendmentId || !bookingRef || !sessionId) {
    return { ok: false, status: 'invalid-params', error: 'amendmentId, bookingRef, and sessionId are required' };
  }

  const bookingRaw = await env.DOSSIERS.get('booking:' + bookingRef);
  if (!bookingRaw) {
    return { ok: false, status: 'booking-not-found', error: 'booking ' + bookingRef + ' not found' };
  }
  const booking = JSON.parse(bookingRaw);

  // Idempotency: amendment processed via stripeAmendmentSessions index
  if (!Array.isArray(booking.stripeAmendmentSessions)) booking.stripeAmendmentSessions = [];
  if (booking.stripeAmendmentSessions.indexOf(sessionId) !== -1) {
    return { ok: true, status: 'already-processed', amendmentId, bookingRef };
  }

  const amRaw = await env.DOSSIERS.get('offer:' + amendmentId);
  if (!amRaw) {
    return { ok: false, status: 'amendment-not-found', error: 'amendment ' + amendmentId + ' not found' };
  }
  const amendment = JSON.parse(amRaw);

  if (amendment.status === 'accepted') {
    // Already accepted by another path; just record the session and exit.
    booking.stripeAmendmentSessions.push(sessionId);
    await env.DOSSIERS.put('booking:' + bookingRef, JSON.stringify(booking));
    return { ok: true, status: 'already-accepted', amendmentId, bookingRef };
  }

  const now = new Date().toISOString();
  const paid = Number(amountPaid) || 0;

  // 1. Flip amendment offer to accepted
  amendment.status = 'accepted';
  amendment.acceptedAt = now;
  amendment.stripeAmendmentSessionId = sessionId;
  amendment.depositDeltaPaid = paid;
  await env.DOSSIERS.put('offer:' + amendmentId, JSON.stringify(amendment));

  // 2. Mark original offer superseded
  if (amendment.amendment_of) {
    const origRaw = await env.DOSSIERS.get('offer:' + amendment.amendment_of);
    if (origRaw) {
      const orig = JSON.parse(origRaw);
      orig.status = 'superseded_by_amendment';
      orig.superseded_by = amendmentId;
      await env.DOSSIERS.put('offer:' + amendment.amendment_of, JSON.stringify(orig));
    }
  }

  // 3. Update booking with amendment's effective state
  booking.room = amendment.room;
  booking.arrival = amendment.arrival;
  booking.departure = amendment.departure;
  booking.guests = amendment.guests;
  booking.total_amount = amendment.total_amount;
  booking.deposit_amount = amendment.deposit_amount;
  booking.confirmed_total_amount = amendment.total_amount;
  booking.confirmed_deposit_amount = amendment.deposit_amount;
  booking.depositPaidAmount = (Number(booking.depositPaidAmount) || 0) + paid;
  booking.active_offer_id = amendmentId;
  if (!Array.isArray(booking.amendments)) booking.amendments = [];
  booking.amendments.push(amendmentId);
  booking.pending_amendment_id = null;
  booking.lastAmendedAt = now;
  booking.stripeAmendmentSessions.push(sessionId);
  booking.updatedAt = now;
  await env.DOSSIERS.put('booking:' + bookingRef, JSON.stringify(booking));

  // 4. Post amendment_accepted system card into the conversation
  try {
    const convId = booking.conversationId;
    if (convId) {
      const convRaw = await env.DOSSIERS.get('conversation:' + convId);
      if (convRaw) {
        const conv = JSON.parse(convRaw);
        const msgsRaw = await env.DOSSIERS.get('conversation:' + convId + ':messages');
        const messages = msgsRaw ? JSON.parse(msgsRaw) : [];
        const cardTs = new Date().toISOString();
        messages.push({
          id: 'msg_' + Date.now() + '_amok',
          role: 'system',
          type: 'amendment_accepted',
          amendmentId: amendmentId,
          bookingRef: bookingRef,
          amendmentSummary: {
            propertyName: amendment.propertyName || '',
            room: amendment.room || '',
            arrival: amendment.arrival || '',
            departure: amendment.departure || '',
            guests: amendment.guests || 0,
            total_amount: amendment.total_amount || 0,
            deposit_amount: amendment.deposit_amount || 0,
            delta_total: amendment.delta_total || 0,
            delta_deposit: amendment.delta_deposit || 0,
            previous_state: amendment.previous_state || null,
          },
          text: 'Booking updated. Your additional deposit of $' + paid.toLocaleString() + ' has been received \u2014 the property will collect the remaining balance from you directly.',
          sentAt: cardTs,
          timestamp: cardTs,
        });
        conv.lastMessageAt = cardTs;
        conv.lastMessagePreview = '\u2713 Booking updated \u00b7 ' + (amendment.propertyName || 'Property');
        conv.unreadAdmin = (conv.unreadAdmin || 0) + 1;
        await env.DOSSIERS.put('conversation:' + convId, JSON.stringify(conv));
        await env.DOSSIERS.put('conversation:' + convId + ':messages', JSON.stringify(messages));
      }
    }
  } catch (e) {
    console.error('[confirmAmendmentPayment] system card post failed:', e && e.message);
  }

  // 5. Confirmation emails
  if (typeof sendBrandedEmail === 'function') {
    try {
      const adminRecipients = await loadNotificationRecipients(env);
      const propertyName = booking.property || booking.propertyName || booking.slug || 'Property';
      const fmtMoney = function(n) { return '$' + (Number(n) || 0).toLocaleString(); };
      const beforeS = amendment.previous_state || {};

      // Property + admin email
      await sendBrandedEmail({
        env, logTag: 'Amendment-Stripe-Internal',
        to: adminRecipients,
        subject: '[CONFIRMED] Amendment + commission paid \u00b7 ' + propertyName + ' \u00b7 ' + bookingRef,
        text: 'Amendment confirmed via Stripe.\n\nProperty: ' + propertyName + '\nBooking: ' + bookingRef + '\nCommission delta paid to The Bearing: ' + fmtMoney(paid) + '\nBalance remaining (property collects from guest): ' + fmtMoney((amendment.delta_total || 0) - paid) + '\n\nReview: https://thebearing.io/admin-conversations.html?id=' + (booking.conversationId || ''),
        shell: {
          preheader: 'Amendment commission settled via Stripe.',
          kicker: 'The Bearing \u00b7 Internal',
          heading: 'Amendment confirmed \u00b7 commission received',
          intro: 'The guest has approved and paid the commission delta for the change to <strong>' + propertyName + '</strong> (' + bookingRef + ').',
          bodyHtml:
            '<table style="width:100%;border-collapse:collapse;font-size:.9rem;margin:0 0 22px;">' +
            '<tr><td style="padding:6px 0;color:#7a6a58;width:50%;">Commission paid to The Bearing</td><td style="padding:6px 0;color:#1e1810;font-weight:600;">' + fmtMoney(paid) + '</td></tr>' +
            '<tr><td style="padding:6px 0;color:#7a6a58;">Balance for property to collect from guest</td><td style="padding:6px 0;color:#1e1810;font-weight:600;">' + fmtMoney((amendment.delta_total || 0) - paid) + '</td></tr>' +
            '<tr><td style="padding:6px 0;color:#7a6a58;">New booking total</td><td style="padding:6px 0;color:#1e1810;font-weight:600;">' + fmtMoney(amendment.total_amount) + '</td></tr>' +
            '</table>' +
            '<div style="background:#fff8f4;border:1px solid rgba(176,88,48,.18);border-radius:10px;padding:14px 18px;margin:0 0 22px;color:#5a4a38;font-size:.85rem;line-height:1.5;">' +
            '<strong style="color:#b05830;">Action for property:</strong> Collect the remaining ' + fmtMoney((amendment.delta_total || 0) - paid) + ' from the guest using your normal settlement flow.' +
            '</div>',
          ctaUrl: 'https://thebearing.io/admin-conversations.html?id=' + (booking.conversationId || ''),
          ctaLabel: 'Open the conversation',
          footerNote: 'You\u2019re receiving this because you handle confirmed bookings.',
          refLabel: bookingRef,
        },
      });

      // Guest confirmation
      if (booking.email) {
        const replyToken = booking.conversationId
          ? ('reply+' + booking.conversationId + '@replies.thebearing.io')
          : undefined;
        await sendBrandedEmail({
          env, logTag: 'Amendment-Stripe-Guest',
          to: [booking.email],
          replyTo: replyToken,
          subject: 'Booking updated \u00b7 ' + propertyName + ' \u00b7 ' + bookingRef,
          text: 'Your booking change has been confirmed and your additional deposit of ' + fmtMoney(paid) + ' has been received.\n\nNew details:\nRoom: ' + amendment.room + '\nDates: ' + amendment.arrival + ' \u2192 ' + amendment.departure + '\nGuests: ' + amendment.guests + '\nNew total: ' + fmtMoney(amendment.total_amount) + '\n\nThe property will collect the remaining balance directly from you.',
          shell: {
            preheader: 'Your booking has been updated.',
            kicker: 'The Bearing',
            heading: 'Your booking has been updated',
            intro: 'Thank you. Your additional deposit of <strong>' + fmtMoney(paid) + '</strong> has been received and the change to <strong>' + propertyName + '</strong> is confirmed.',
            bodyHtml:
              '<table style="width:100%;border-collapse:collapse;font-size:.9rem;margin:0 0 22px;">' +
              '<tr><td style="padding:6px 0;color:#7a6a58;width:35%;">Room</td><td style="padding:6px 0;color:#7a6a58;text-decoration:line-through;">' + (beforeS.room || '\u2014') + '</td><td style="padding:6px 0;color:#1e1810;font-weight:600;">\u2192 ' + (amendment.room || '\u2014') + '</td></tr>' +
              '<tr><td style="padding:6px 0;color:#7a6a58;">Dates</td><td style="padding:6px 0;color:#7a6a58;text-decoration:line-through;">' + beforeS.arrival + ' \u2192 ' + beforeS.departure + '</td><td style="padding:6px 0;color:#1e1810;font-weight:600;">\u2192 ' + amendment.arrival + ' \u2192 ' + amendment.departure + '</td></tr>' +
              '<tr><td style="padding:6px 0;color:#7a6a58;">Guests</td><td style="padding:6px 0;color:#7a6a58;text-decoration:line-through;">' + beforeS.guests + '</td><td style="padding:6px 0;color:#1e1810;font-weight:600;">\u2192 ' + amendment.guests + '</td></tr>' +
              '<tr><td style="padding:6px 0;color:#7a6a58;">New total</td><td colspan="2" style="padding:6px 0;color:#1e1810;font-weight:600;">' + fmtMoney(amendment.total_amount) + '</td></tr>' +
              '</table>' +
              '<div style="background:#f5f1e9;border:1px solid rgba(80,55,25,.10);border-radius:10px;padding:14px 18px;margin:0 0 22px;color:#5a4a38;font-size:.85rem;line-height:1.5;">' +
              'The property will collect the remaining balance for this change (' + fmtMoney((amendment.delta_total || 0) - paid) + ') directly from you, using their normal settlement flow.' +
              '</div>',
            ctaUrl: 'https://thebearing.io/conversations.html?id=' + (booking.conversationId || ''),
            ctaLabel: 'View the conversation',
            footerNote: 'You can reply to this email \u2014 your response will land in your conversation.',
            refLabel: bookingRef,
          },
        });
      }
    } catch (e) { console.error('[confirmAmendmentPayment] email failed:', e && e.message); }
  }

  return { ok: true, status: 'amendment-confirmed', amendmentId, bookingRef, amountPaid: paid };
}
