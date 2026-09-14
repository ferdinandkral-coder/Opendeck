// OpenDeck proxy — deploy this on Cloudflare Workers (free tier).
//
// Why this exists: adsb.lol / adsb.fi / airframes.io don't send CORS
// headers for arbitrary browser origins, and public CORS proxies
// (corsproxy.io, allorigins.win) are unreliable — they rate-limit or
// block without warning. This worker is yours: stable, free, and only
// forwards to the three hosts OpenDeck actually needs (not an open
// relay for arbitrary URLs).
//
// Deploy (no CLI needed):
//   1. https://dash.cloudflare.com -> Workers & Pages -> Create -> Worker
//   2. Give it a name (e.g. "opendeck-proxy"), click "Deploy" once to scaffold it
//   3. Click "Edit code", delete everything, paste this whole file, click "Deploy"
//   4. Copy the resulting URL (https://opendeck-proxy.<you>.workers.dev)
//   5. Paste it into OpenDeck's ⚙ Einstellungen -> "Eigener Proxy"

const ALLOWED_HOSTS = new Set([
  "api.adsb.lol",
  "opendata.adsb.fi",
  "api.airframes.io",
]);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return new Response("Missing ?url= parameter", { status: 400, headers: corsHeaders() });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response("Invalid url parameter", { status: 400, headers: corsHeaders() });
    }

    if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
      return new Response(`Host not allowed: ${targetUrl.hostname}`, {
        status: 403,
        headers: corsHeaders(),
      });
    }

    try {
      const upstreamHeaders = {};
      const auth = request.headers.get("authorization");
      if (auth) upstreamHeaders["authorization"] = auth;

      const upstream = await fetch(targetUrl.toString(), { headers: upstreamHeaders });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: {
          ...corsHeaders(),
          "Content-Type": upstream.headers.get("content-type") || "application/json",
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 502,
        headers: corsHeaders(),
      });
    }
  },
};
