export async function onRequestPost({ request, env }) {
  // Forward the browser's request body straight to Anthropic,
  // adding the secret API key from the environment variable.
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

  // Return Anthropic's response as-is to the browser
  return new Response(anthropicResponse.body, {
    status: anthropicResponse.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// Handle CORS preflight requests (some browsers send these)
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
