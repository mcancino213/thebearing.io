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
// All other paths fall through to static asset serving.

const CF_ACCOUNT_ID = 'd62dd7db798247bb6cc9ff18ff7ee84f';
const CF_ACCOUNT_HASH = 'YyCqpmHo4EG6ShyDMCRcVQ';

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
      // Path 1: Clerk session token (most secure)
      const sessionToken = request.headers.get('X-Clerk-Session');
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
                return emails.some(function(em) { return allowlist.indexOf(em) !== -1; });
              }
            }
          }
        } catch(e) { console.log('[Admin] Clerk verify failed:', e.message); }
      }

      // Path 2: Email header (less secure — spoof-able, but raises the bar)
      // Useful when CLERK_SECRET_KEY isn't set yet
      const emailHeader = request.headers.get('X-Admin-Email');
      if (emailHeader) {
        return allowlist.indexOf(emailHeader.toLowerCase()) !== -1;
      }

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
          // Return index
          const rawIndex = await env.DOSSIERS.get('__property_index');
          const slugs = rawIndex ? JSON.parse(rawIndex) : [];
          return jsonResponse({ slugs });
        }
        const raw = await env.DOSSIERS.get(slug + ':property');
        let data = null;
        if (raw) {
          try { data = JSON.parse(raw); } catch (e) { data = null; }
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
          return jsonResponse({ error: 'slug required' }, 400);
        }
        if (!body.property || typeof body.property !== 'object') {
          return jsonResponse({ error: 'property object required' }, 400);
        }
        const serialized = JSON.stringify(body.property);
        await env.DOSSIERS.put(body.slug + ':property', serialized);

        // Update index
        const rawIndex = await env.DOSSIERS.get('__property_index');
        let slugs = rawIndex ? JSON.parse(rawIndex) : [];
        if (!slugs.includes(body.slug)) {
          slugs.push(body.slug);
          await env.DOSSIERS.put('__property_index', JSON.stringify(slugs));
        }
        return jsonResponse({ ok: true, slug: body.slug, length: serialized.length });
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
      if (request.method === 'GET') {
        const ref = url.searchParams.get('ref');
        if (ref) {
          const raw = await env.DOSSIERS.get('booking:' + ref);
          const data = raw ? JSON.parse(raw) : null;
          return jsonResponse({ ref, data, exists: !!data });
        }
        const rawIndex = await env.DOSSIERS.get('__bookings_index');
        const refs = rawIndex ? JSON.parse(rawIndex) : [];
        const bookings = await Promise.all(refs.map(async (r) => {
          const raw = await env.DOSSIERS.get('booking:' + r);
          return raw ? { ref: r, ...JSON.parse(raw) } : null;
        }));
        return jsonResponse({ bookings: bookings.filter(Boolean).reverse() });
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
        const { ref, status, paymentStatus, notes } = body;
        if (!ref) return jsonResponse({ error: 'ref required' }, 400);
        const raw = await env.DOSSIERS.get('booking:' + ref);
        if (!raw) return jsonResponse({ error: 'booking not found' }, 404);
        const booking = JSON.parse(raw);
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
          const { id, role, text, senderName, senderEmail } = body;
          if (!id || !text) return jsonResponse({ error: 'id and text required' }, 400);

          const convRaw = await env.DOSSIERS.get('conversation:' + id);
          if (!convRaw) return jsonResponse({ error: 'conversation not found' }, 404);
          const conv = JSON.parse(convRaw);

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
                      reply_to: `reply+${id}@thebearing.io`,
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
                  await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      from: 'The Bearing <bookings@thebearing.io>',
                      to: adminRecipients,
                      subject: `Reply from ${conv.guestName} — ${conv.propertyName}`,
                      text: `${conv.guestName} replied:\n\n"${text}"\n\nView conversation: https://thebearing.io/admin-conversations.html?id=${id}\n\n—\nMute email notifications for this conversation: ${unsubUrl}`
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
        const m = String(addr).match(/reply\+([a-zA-Z0-9_]+)@thebearing\.io/i);
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
            try {
              const j = await resp.json();
              if (Array.isArray(j && j.data)) domainCount = j.data.length;
            } catch(_) {}
            checks.resend = {
              ok: true,
              status: 'connected',
              detail: domainCount === null ? 'API key valid' : (domainCount + ' sending domain(s) configured')
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

      // Cron schedule + last run
      let lastRun = null;
      try {
        const raw = await env.DOSSIERS.get('__cron:last_run');
        if (raw) lastRun = JSON.parse(raw);
      } catch(_) {}
      checks.cron = {
        ok: !!lastRun,
        status: lastRun ? 'last ran ' + lastRun.ranAt : 'no runs recorded',
        detail: lastRun
          ? `Scanned ${lastRun.scanned} convs, sent ${lastRun.sent} reminders in ${lastRun.durationMs}ms` + (lastRun.error ? ` — error: ${lastRun.error}` : '')
          : 'Stale-conversation cron has not yet run (or last run pre-dates v72f). Configured: hourly (0 * * * *).',
        schedule: '0 * * * * (hourly)',
        lastRun: lastRun
      };

      return jsonResponse({ ok: true, checks, generatedAt: new Date().toISOString() });
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
  if (!env.DOSSIERS || !env.RESEND_API_KEY) {
    console.log('[Cron] Skipping — missing DOSSIERS or RESEND_API_KEY');
    return;
  }
  const startedAt = Date.now();
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
// edited via admin-settings.html without redeploying. The baseline founder
// address `miguel@thebearing.io` (and the `admin@thebearing.io` admin login) is
// always merged in as a failsafe so the admin can never lose access by mistake.

const BASELINE_NOTIFICATION_RECIPIENT = 'miguel@thebearing.io';

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