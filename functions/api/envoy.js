export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Only handle requests to /api/envoy — everything else falls through to static assets
    if (url.pathname !== '/api/envoy') {
      return env.ASSETS.fetch(request);
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    // Only POST is allowed for the actual proxy
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Forward the request body to Anthropic, adding the secret API key
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
};
