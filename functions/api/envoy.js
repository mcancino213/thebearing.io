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
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
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
                  to: ['miguel@thebearing.io'],
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

        // List all conversations (admin)
        const rawIndex = await env.DOSSIERS.get('__conversations_index');
        const ids = rawIndex ? JSON.parse(rawIndex) : [];
        const convs = (await Promise.all(ids.slice(-50).map(async i => {
          const r = await env.DOSSIERS.get('conversation:' + i);
          return r ? JSON.parse(r) : null;
        }))).filter(Boolean).reverse();
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
            unreadAdmin: 1, unreadGuest: 0
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

          // Email admin/partner notification
          if (env.RESEND_API_KEY && firstMessage) {
            try {
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  from: 'The Bearing <bookings@thebearing.io>',
                  to: ['miguel@thebearing.io'],
                  subject: `New enquiry — ${propertyName} from ${guestName || guestEmail}`,
                  text: `New enquiry received.\n\nGuest: ${guestName || guestEmail} (${guestEmail})\nProperty: ${propertyName}\n\nMessage:\n${firstMessage}\n\nReply at: https://thebearing.io/admin-conversation.html?id=${id}`
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
          if (role === 'guest') conv.unreadAdmin = (conv.unreadAdmin || 0) + 1;
          else conv.unreadGuest = (conv.unreadGuest || 0) + 1;

          await env.DOSSIERS.put('conversation:' + id, JSON.stringify(conv));
          await env.DOSSIERS.put('conversation:' + id + ':messages', JSON.stringify(messages));

          // Email notification to the other party
          if (env.RESEND_API_KEY) {
            try {
              if (role === 'admin' || role === 'partner') {
                // Notify guest
                const replyUrl = `https://thebearing.io/channels.html?id=${id}`;
                const displaySender = senderName || conv.propertyName;
                await fetch('https://api.resend.com/emails', {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    from: `${conv.propertyName} via The Bearing <bookings@thebearing.io>`,
                    to: [conv.guestEmail],
                    reply_to: `reply+${id}@thebearing.io`,
                    subject: `New message about your ${conv.propertyName} enquiry`,
                    text: `${displaySender} sent you a message on The Bearing:\n\n"${text}"\n\nYou can reply to this email or view the conversation channel here:\n${replyUrl}\n\n— The Bearing\nhttps://thebearing.io`
                  })
                });
              } else {
                // Notify admin
                await fetch('https://api.resend.com/emails', {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    from: 'The Bearing <bookings@thebearing.io>',
                    to: ['miguel@thebearing.io'],
                    subject: `Reply from ${conv.guestName} — ${conv.propertyName}`,
                    text: `${conv.guestName} replied:\n\n"${text}"\n\nView conversation: https://thebearing.io/admin-conversation.html?id=${id}`
                  })
                });
              }
            } catch(e) { console.error('[Conv] Notify email error:', e.message); }
          }

          return jsonResponse({ ok: true, message: msg });
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
        return jsonResponse({ ok: true });
      }
    }

    // ── /api/inbound-email ────────────────────────────────────────
    // Resend inbound webhook — parses email replies and saves to conversation
    // Setup: In Resend dashboard → Inbound → Add route for reply+*@thebearing.io
    // Webhook URL: https://thebearing.io/api/inbound-email
    if (url.pathname === '/api/inbound-email') {
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      let body;
      try { body = await request.json(); }
      catch(e) { return jsonResponse({ error: 'invalid JSON' }, 400); }

      // Resend inbound email format:
      // body.to = ["reply+conv_xxx@thebearing.io"]
      // body.from = "guest@email.com"
      // body.text = email body text
      // body.subject = "Re: New message from..."

      const toAddresses = body.to || [];
      let convId = null;

      // Extract conversation ID from reply+{id}@thebearing.io
      for (const addr of toAddresses) {
        const m = addr.match(/reply\+([a-zA-Z0-9_]+)@thebearing\.io/);
        if (m) { convId = m[1]; break; }
      }

      if (!convId) return jsonResponse({ error: 'no conversation ID in recipient' }, 400);

      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      const convRaw = await env.DOSSIERS.get('conversation:' + convId);
      if (!convRaw) return jsonResponse({ error: 'conversation not found' }, 404);
      const conv = JSON.parse(convRaw);

      // Extract reply text — strip quoted content (lines starting with >)
      let text = (body.text || '').trim();
      // Remove quoted reply content
      text = text.split('\n')
        .filter(line => !line.trim().startsWith('>'))
        .join('\n')
        .trim();
      // Remove common email signature separators
      const sigSeparators = ['--\n', '— The Bearing', 'On ', 'Sent from'];
      for (const sep of sigSeparators) {
        const idx = text.indexOf(sep);
        if (idx > 20) { text = text.substring(0, idx).trim(); break; }
      }

      if (!text || text.length < 2) {
        return jsonResponse({ ok: true, skipped: 'empty reply' });
      }

      // Save message as guest reply
      const msgsRaw = await env.DOSSIERS.get('conversation:' + convId + ':messages');
      const messages = msgsRaw ? JSON.parse(msgsRaw) : [];
      const now = new Date().toISOString();
      const msg = {
        id: 'msg_' + Date.now(),
        role: 'guest',
        text,
        senderName: conv.guestName || body.from || 'Guest',
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

      // Notify admin
      if (env.RESEND_API_KEY) {
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'The Bearing <bookings@thebearing.io>',
              to: ['miguel@thebearing.io'],
              subject: `Email reply from ${conv.guestName} — ${conv.propertyName}`,
              text: `${conv.guestName} replied via email:\n\n"${text}"\n\nView conversation: https://thebearing.io/admin-conversations.html`
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

    // ── Everything else → static assets ───────────────────────────
    return env.ASSETS.fetch(request);
  }
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
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