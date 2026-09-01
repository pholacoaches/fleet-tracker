/**
 * FleetDesk AI proxy — Cloudflare Worker (fleet-proxy)
 *
 * Audit fix #1 (2026-08-25). Replaces the previous catch-all proxy that
 * forwarded any body on any path to Anthropic with CORS "*" and no auth,
 * and that still exposed the legacy /login and /auth/* OTP routes.
 *
 * Exactly two call paths exist:
 *
 *   POST /ai/dashboard   Fuel-statement PDF extraction from index.html.
 *                        Caller must be a signed-in FleetDesk user:
 *                        Authorization: Bearer <Supabase access token>.
 *                        The token is verified against Supabase Auth
 *                        (GET /auth/v1/user) on every call.
 *
 *   POST /ai/driver      Odometer photo reading from driver.html.
 *                        Caller must present an active driver code:
 *                        X-Driver-Code: AAA-0000.
 *                        The code is validated with the driver_page_init
 *                        RPC (returns null for unknown / inactive codes).
 *
 * Everything else — including "/", "/login", "/auth/*" — is 404.
 *
 * Model and max_tokens are pinned here and the client's values ignored.
 * The driver path also pins the prompt: the client may only send the
 * photo, so a leaked driver code is worth nothing more than "read an
 * odometer".
 *
 * Secrets / vars (see wrangler.jsonc + README.md):
 *   ANTHROPIC_API_KEY   secret — Anthropic key (existing)
 *   SUPABASE_URL        var    — https://wlwwzbyuchsonwugqhww.supabase.co
 *   SUPABASE_ANON_KEY   var    — the publishable key (not a secret; it is
 *                                in the page source anyway)
 *   DRIVER_RATE_LIMIT   optional Rate Limiting binding (see README)
 */

// ── Pinned AI settings ───────────────────────────────────────────────────────
// Kept identical to what the app sends today (index.html:2169, driver.html:476).
const DASHBOARD_MODEL = 'claude-sonnet-4-6';
const DASHBOARD_MAX_TOKENS = 4000;
const DRIVER_MODEL = 'claude-sonnet-4-6';
const DRIVER_MAX_TOKENS = 100;

// Pilot fix 1a: the old "return only digits" prompt made the model give up on
// dashboards showing several numbers (total + trip meter) — it returned
// nothing on a clear photo. Target the TOTAL odometer explicitly and demand
// strict JSON so the client can tell "unreadable" from "garbage".
const DRIVER_PROMPT =
  'This is a photo of a vehicle dashboard. Read the TOTAL odometer only — the cumulative kilometre ' +
  'figure, normally the larger integer with no decimal point. IGNORE trip meters (usually smaller, ' +
  'with a decimal point, often labelled TRIP, A or B) and every other number on the dashboard ' +
  '(clock, speed, fuel range, temperature). Never join two numbers together. The total odometer is ' +
  'at most 7 digits. If the total odometer is genuinely unreadable, use null. ' +
  'Respond with ONLY strict JSON, no markdown, no code fences, exactly this shape: ' +
  '{"odometer": <integer or null>, "confidence": "high"|"medium"|"low"}';

// ── CORS ─────────────────────────────────────────────────────────────────────
// Production origin only. The localhost entries exist for local testing —
// 8787 is `wrangler dev`, 8377 is the static app server in .claude/launch.json.
// REMOVE BOTH before the first client goes live: delete the two lines marked
// DEV-ONLY below and redeploy.
const ALLOWED_ORIGINS = new Set([
  'https://pholacoaches.github.io',
  'http://localhost:8787', // DEV-ONLY — remove before go-live
  'http://localhost:8377', // DEV-ONLY — remove before go-live
]);

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Request body caps (bytes, on the raw JSON). A 3-page PDF chunk base64'd is
// usually well under 5 MB; driver photos are compressed to ~200 KB client-side.
const MAX_BODY_DASHBOARD = 20 * 1024 * 1024;
const MAX_BODY_DRIVER = 2 * 1024 * 1024;

const DRIVER_CODE_RE = /^[A-Z]{3}-[0-9]{4}$/;

// ── Helpers ──────────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Driver-Code',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// Same error shape the app already reads: data.error.message (index.html:2178)
function jsonError(origin, status, type, message) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
  });
}

function originAllowed(request) {
  const origin = request.headers.get('Origin');
  return !!origin && ALLOWED_ORIGINS.has(origin);
}

async function readJsonBody(request, maxBytes) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > maxBytes) return { error: 'Request body too large' };
  const text = await request.text();
  if (text.length > maxBytes) return { error: 'Request body too large' };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: 'Body must be valid JSON' };
  }
}

// ── Auth: dashboard (Supabase JWT) ───────────────────────────────────────────
// Returns the Supabase user on success, or null. A network failure counts as
// "not verified" — we never fall open.
async function verifySupabaseUser(env, token) {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user || !user.id || user.aud !== 'authenticated') return null;
    return user;
  } catch {
    return null;
  }
}

// ── Auth: driver (personal code via driver_page_init) ────────────────────────
// driver_page_init is SECURITY DEFINER and returns null for unknown or
// inactive codes, so a non-null JSON body means "active driver".
async function verifyDriverCode(env, code) {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/driver_page_init`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_code: code }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object' || !data.name) return null;
    return data;
  } catch {
    return null;
  }
}

// ── Anthropic call ───────────────────────────────────────────────────────────
// Passes Anthropic's status + JSON straight through (the app reads
// data.content / data.error.message), with our CORS headers instead of "*".
async function callAnthropic(env, origin, payload) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
  });
}

// ── Route: POST /ai/dashboard ────────────────────────────────────────────────
// Body contract (unchanged from today): { messages: [ { role:'user', content:[
//   { type:'document', source:{ type:'base64', media_type:'application/pdf', data } },
//   { type:'text', text } ] } ] }
// Only `messages` is taken from the client; model/max_tokens are pinned; the
// content blocks are whitelisted so the proxy can't be used as a general chat.
async function handleDashboard(request, env, origin) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return jsonError(origin, 401, 'authentication_error', 'Sign in to use AI extraction.');

  const user = await verifySupabaseUser(env, token);
  if (!user) return jsonError(origin, 401, 'authentication_error', 'Your session is not valid. Please log in again.');

  const { body, error } = await readJsonBody(request, MAX_BODY_DASHBOARD);
  if (error) return jsonError(origin, 400, 'invalid_request_error', error);

  const messages = sanitiseMessages(body && body.messages, {
    allowDocument: true,
    allowImage: false,
    allowText: true,
  });
  if (!messages) return jsonError(origin, 400, 'invalid_request_error', 'Request must contain one user message with a PDF document and a text instruction.');

  return callAnthropic(env, origin, {
    model: DASHBOARD_MODEL,
    max_tokens: DASHBOARD_MAX_TOKENS,
    messages,
  });
}

// ── Route: POST /ai/driver ───────────────────────────────────────────────────
// Body contract: same shape as today, but ONLY the image block is used — the
// prompt is DRIVER_PROMPT above, whatever the client sends.
async function handleDriver(request, env, origin) {
  const code = (request.headers.get('X-Driver-Code') || '').trim().toUpperCase();
  if (!DRIVER_CODE_RE.test(code)) return jsonError(origin, 401, 'authentication_error', 'Driver code missing or malformed.');

  // Optional Rate Limiting binding — see README. Keyed by code so one leaked
  // or guessed code can't be hammered; guessing itself is throttled at the
  // Cloudflare rule level (README).
  if (env.DRIVER_RATE_LIMIT) {
    const { success } = await env.DRIVER_RATE_LIMIT.limit({ key: code });
    if (!success) return jsonError(origin, 429, 'rate_limit_error', 'Too many requests — please wait a minute and try again.');
  }

  const driver = await verifyDriverCode(env, code);
  if (!driver) return jsonError(origin, 401, 'authentication_error', 'Driver code not recognised.');

  const { body, error } = await readJsonBody(request, MAX_BODY_DRIVER);
  if (error) return jsonError(origin, 400, 'invalid_request_error', error);

  const image = extractSingleImage(body && body.messages);
  if (!image) return jsonError(origin, 400, 'invalid_request_error', 'Request must contain one JPEG image of the odometer.');

  return callAnthropic(env, origin, {
    model: DRIVER_MODEL,
    max_tokens: DRIVER_MAX_TOKENS,
    messages: [{ role: 'user', content: [image, { type: 'text', text: DRIVER_PROMPT }] }],
  });
}

// ── Content whitelisting ─────────────────────────────────────────────────────
const BASE64_RE = /^[A-Za-z0-9+/=\r\n]+$/;

function validBase64Source(src, mediaTypes) {
  return (
    src &&
    src.type === 'base64' &&
    mediaTypes.includes(src.media_type) &&
    typeof src.data === 'string' &&
    src.data.length > 0 &&
    BASE64_RE.test(src.data)
  );
}

// Rebuilds the messages array from scratch, keeping only recognised block
// types with recognised fields. Returns null if the shape is wrong.
function sanitiseMessages(messages, opts) {
  if (!Array.isArray(messages) || messages.length !== 1) return null;
  const m = messages[0];
  if (!m || m.role !== 'user' || !Array.isArray(m.content) || m.content.length === 0 || m.content.length > 4) return null;
  const content = [];
  for (const block of m.content) {
    if (!block || typeof block !== 'object') return null;
    if (block.type === 'document' && opts.allowDocument) {
      if (!validBase64Source(block.source, ['application/pdf'])) return null;
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: block.source.data } });
    } else if (block.type === 'image' && opts.allowImage) {
      if (!validBase64Source(block.source, ['image/jpeg', 'image/png', 'image/webp'])) return null;
      content.push({ type: 'image', source: { type: 'base64', media_type: block.source.media_type, data: block.source.data } });
    } else if (block.type === 'text' && opts.allowText) {
      if (typeof block.text !== 'string' || block.text.length === 0 || block.text.length > 8000) return null;
      content.push({ type: 'text', text: block.text });
    } else {
      return null;
    }
  }
  if (!content.some((b) => b.type === 'document' || b.type === 'image')) return null;
  return [{ role: 'user', content }];
}

function extractSingleImage(messages) {
  if (!Array.isArray(messages) || messages.length !== 1) return null;
  const m = messages[0];
  if (!m || !Array.isArray(m.content)) return null;
  const images = m.content.filter((b) => b && b.type === 'image');
  if (images.length !== 1) return null;
  const src = images[0].source;
  if (!validBase64Source(src, ['image/jpeg', 'image/png', 'image/webp'])) return null;
  return { type: 'image', source: { type: 'base64', media_type: src.media_type, data: src.data } };
}

// ── Router ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const known = path === '/ai/dashboard' || path === '/ai/driver';

    // Preflight: only for known routes and allowed origins; otherwise the
    // browser gets no CORS headers and blocks the call.
    if (request.method === 'OPTIONS') {
      if (!known || !originAllowed(request)) return new Response(null, { status: 404 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!known) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });

    // Browser calls always carry Origin on a cross-site POST. Anything without
    // an allowed Origin (curl, other sites) is refused outright.
    if (!originAllowed(request)) return jsonError(origin, 403, 'permission_error', 'Origin not allowed.');

    if (!env.ANTHROPIC_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      return jsonError(origin, 500, 'api_error', 'Proxy is not configured.');
    }

    try {
      if (path === '/ai/dashboard') return await handleDashboard(request, env, origin);
      return await handleDriver(request, env, origin);
    } catch (err) {
      // Never echo internals to the client.
      console.error('fleet-proxy error:', err && err.message);
      return jsonError(origin, 502, 'api_error', 'The AI service could not be reached. Please try again.');
    }
  },
};
