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

    // ── /api/envoy — Anthropic API proxy ──────────────────────────
    if (url.pathname === '/api/envoy') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }
      const body = await request.text();
      const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: body
      });
      return new Response(anthropicResponse.body, {
        status: anthropicResponse.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
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

    // ── /api/members — member list (read/write) ───────────────────────────
    // Keys: member:{userId}  (JSON)
    // Index: __members_index  (JSON array of userIds)
    if (url.pathname === '/api/members') {
      if (!env.DOSSIERS) return jsonResponse({ error: 'KV not bound' }, 500);

      // GET ?id=... → single member
      // GET        → full list
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

      // POST { id, email, name, provider, ... } → upsert member
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
        if (!body.id) return jsonResponse({ error: 'id required' }, 400);
        const member = {
          id: body.id,
          email: body.email || '',
          name: body.name || '',
          provider: body.provider || 'email',
          tier: body.tier || 'member',
          joined_at: body.joined_at || new Date().toISOString(),
          last_active: new Date().toISOString(),
          bookings: body.bookings || 0,
          ltv: body.ltv || 0,
          location: body.location || '',
          avatar: body.avatar || '',
        };
        await env.DOSSIERS.put('member:' + body.id, JSON.stringify(member));
        // Update index
        const rawIndex = await env.DOSSIERS.get('__members_index');
        let ids = rawIndex ? JSON.parse(rawIndex) : [];
        if (!ids.includes(body.id)) { ids.push(body.id); await env.DOSSIERS.put('__members_index', JSON.stringify(ids)); }
        return jsonResponse({ ok: true, member });
      }

      // DELETE ?id=...
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

    // ── /api/clerk-webhook — receives Clerk user lifecycle events ─────────
    // Verifies Svix signature, auto-creates member on user.created
    if (url.pathname === '/api/clerk-webhook') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

      // Verify Svix webhook signature
      const webhookSecret = env.CLERK_WEBHOOK_SECRET;
      if (webhookSecret) {
        const svixId        = request.headers.get('svix-id');
        const svixTimestamp = request.headers.get('svix-timestamp');
        const svixSignature = request.headers.get('svix-signature');
        if (!svixId || !svixTimestamp || !svixSignature) {
          return jsonResponse({ error: 'Missing svix headers' }, 400);
        }
        // Simple timestamp replay protection (5 min window)
        const ts = parseInt(svixTimestamp);
        if (Math.abs(Date.now() / 1000 - ts) > 300) {
          return jsonResponse({ error: 'Timestamp too old' }, 400);
        }
        // Signature verification using Web Crypto
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
        // No secret set — just process (dev mode)
        let event;
        try { event = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid JSON' }, 400); }
        await handleClerkEvent(event, env);
      }
      return jsonResponse({ ok: true });
    }

async function handleClerkEvent(event, env) {
  if (!env.DOSSIERS) return;
  const type = event.type;
  const data = event.data;

  if (type === 'user.created' || type === 'user.updated') {
    const email = (data.email_addresses || []).find(e => e.id === data.primary_email_address_id);
    const oauth = (data.external_accounts || [])[0];
    const member = {
      id: data.id,
      email: email ? email.email_address : '',
      name: [data.first_name, data.last_name].filter(Boolean).join(' ') || (email ? email.email_address.split('@')[0] : ''),
      provider: oauth ? oauth.provider : 'email',
      avatar: data.image_url || '',
      tier: 'member',
      joined_at: new Date(data.created_at).toISOString(),
      last_active: new Date().toISOString(),
      bookings: 0,
      ltv: 0,
      location: '',
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
