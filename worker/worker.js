/**
 * FleetDesk AI proxy — Cloudflare Worker (fleet-proxy)
 *
 * Audit fix #1 (2026-08-25). Replaces the previous catch-all proxy that
 * forwarded any body on any path to Anthropic with CORS "*" and no auth,
 * and that still exposed the legacy /login and /auth/* OTP routes.
 *
 * Exactly three call paths exist:
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
 *   POST /ai/compliance  Licence-document photo reading from index.html
 *                        (Disc Renewal → Scan Licences, 2026-09-04).
 *                        Same auth + rate-limit bindings as /ai/dashboard;
 *                        same body contract as /ai/driver (one image only,
 *                        prompt pinned here).
 *
 * Everything else — including "/", "/login", "/auth/*" — is 404.
 *
 * Model and max_tokens are pinned here and the client's values ignored.
 * The driver and compliance paths also pin the prompt: the client may only
 * send the photo, so a leaked driver code is worth nothing more than "read
 * an odometer".
 *
 * Secrets / vars (see wrangler.jsonc + README.md):
 *   ANTHROPIC_API_KEY   secret — Anthropic key (existing)
 *   SUPABASE_URL        var    — https://wlwwzbyuchsonwugqhww.supabase.co
 *   SUPABASE_ANON_KEY   var    — the publishable key (not a secret; it is
 *                                in the page source anyway)
 *   ALLOWED_ORIGINS     var    — comma-separated CORS allowlist, differs per
 *                                wrangler environment (prod vs "dev")
 *   DASHBOARD_IP_LIMIT, DASHBOARD_USER_LIMIT, DRIVER_IP_LIMIT, DRIVER_CODE_LIMIT
 *                       Workers Rate Limiting bindings (2026-09-03, see
 *                       "Rate limiting" below and README). All fail open.
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

// Compliance scan (2026-09-04). Same model as the other two routes for now;
// if real licence photos misread, upgrade THIS route (model + structured
// output) with evidence. The office approves every value in a table before
// it is saved, so a misread is caught there, not here.
const COMPLIANCE_MODEL = 'claude-sonnet-4-6';
// 600 (was 300, fix-scan-rotation 2026-09-04): the JSON answer is ~130
// tokens, but on a hard photo the model may open with a sentence before the
// object; 300 cut such replies mid-JSON and the client saw "Unexpected answer".
const COMPLIANCE_MAX_TOKENS = 600;

// The document repeats dates: an issue / transaction "Date" sits right next
// to each "Date of expiry". The prompt names the expiry labels explicitly
// and forbids guessing — a null is far cheaper than a wrong expiry date.
// fix-scan-rotation (2026-09-04): sideways photos produced prose instead of
// JSON — the prompt now says the photo may be rotated and that the answer is
// ALWAYS the JSON object, nulls included, never prose.
const COMPLIANCE_PROMPT =
  'This is a photo of a South African combined "Motor Vehicle Licence, Licence Disc and Operator Card" document ' +
  '(one page, English/Afrikaans). The photo may be rotated sideways or upside down — read it anyway. Read these fields:\n' +
  '1. plate: the vehicle registration printed in the "Licence number" field (e.g. RPF655W). Uppercase letters and digits only, no spaces.\n' +
  '2. disc_expiry: the licence disc expiry date — the line labelled "Roadworthy expiry date" in the licence section.\n' +
  '3. cof_expiry: the "Date of expiry / Vervaldatum" printed under the LEFT circle at the bottom (Certificate of Fitness / roadworthy).\n' +
  '4. op_licence_expiry: the "Date of expiry / Vervaldatum" printed under the RIGHT circle at the bottom (Operator card).\n' +
  '5. disc_no: the licence disc number, if printed and clearly legible.\n' +
  '6. op_licence_no: the operator card / operating licence number, if printed and clearly legible.\n' +
  '7. make_model: the vehicle make and model, if printed.\n' +
  'CRITICAL: the document repeats dates. Near each circle there is also a transaction or issue "Date" (for example "Date 2026-03-27") — ' +
  'that is NOT an expiry date and must be ignored. Use only values explicitly labelled as an expiry ("Date of expiry", "Vervaldatum", "expiry date"). ' +
  'Write every date as YYYY-MM-DD. If any value is missing, obscured or not clearly legible, use null for that field — never guess, infer or copy a value from elsewhere on the page. ' +
  'ALWAYS answer with the JSON object below and nothing else — even if the photo is rotated, blurry, or nothing at all is legible (then every field is null). ' +
  'Never reply with prose, an explanation or an apology. ' +
  'Respond with ONLY strict JSON, no markdown, no code fences, exactly this shape: ' +
  '{"plate": <string or null>, "disc_expiry": <"YYYY-MM-DD" or null>, "cof_expiry": <"YYYY-MM-DD" or null>, ' +
  '"op_licence_expiry": <"YYYY-MM-DD" or null>, "disc_no": <string or null>, "op_licence_no": <string or null>, ' +
  '"make_model": <string or null>, "confidence": "high"|"medium"|"low"}';

// ── CORS ─────────────────────────────────────────────────────────────────────
// The allowlist comes from the ALLOWED_ORIGINS var in wrangler.jsonc, a
// comma-separated list, so it differs per environment (2026-09-02):
//   default env  (fleet-proxy)      production origin only
//   env "dev"    (fleet-proxy-dev)  production + localhost 8787 / 8377
// If the var is missing or empty the Worker fails closed to the production
// origin alone — a mis-deploy can never re-open localhost on production.
const PRODUCTION_ORIGINS = ['https://pholacoaches.github.io'];

function allowedOrigins(env) {
  const raw = typeof env.ALLOWED_ORIGINS === 'string' ? env.ALLOWED_ORIGINS : '';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(list.length ? list : PRODUCTION_ORIGINS);
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Request body caps (bytes, on the raw JSON). A 3-page PDF chunk base64'd is
// usually well under 5 MB; driver photos are compressed to ~200 KB client-side.
const MAX_BODY_DASHBOARD = 20 * 1024 * 1024;
const MAX_BODY_DRIVER = 2 * 1024 * 1024;
// Licence photos are compressed to ~400 KB client-side (small print needs
// more pixels than an odometer); base64 adds a third.
const MAX_BODY_COMPLIANCE = 3 * 1024 * 1024;

const DRIVER_CODE_RE = /^[A-Z]{3}-[0-9]{4}$/;

// ── Helpers ──────────────────────────────────────────────────────────────────
// Computed once per request in fetch(): {} when the Origin is not allowed,
// otherwise the full CORS header set for that origin. Passed down as `cors`.
function corsHeaders(env, origin) {
  if (!origin || !allowedOrigins(env).has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Driver-Code',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// Same error shape the app already reads: data.error.message (index.html:2178)
function jsonError(cors, status, type, message) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
  });
}

// ── Rate limiting ────────────────────────────────────────────────────────────
// Workers Rate Limiting bindings, declared in wrangler.jsonc ("ratelimits",
// both environments). Two layers per route:
//   per IP        checked in the router before the config check and before any
//                 Supabase call — the cheapest gate, keyed on CF-Connecting-IP
//   per identity  checked inside the handler once the caller is known:
//                 driver code (after the regex, before the RPC) / Supabase user id
// Every check FAILS OPEN: a missing binding or a throwing limit() call logs a
// warning and lets the request through. Throttling must never take real users
// down; the Anthropic spend cap remains the hard backstop.
// The binding only answers success/failure (no remaining-time figure), so
// Retry-After is the window length.
const RETRY_AFTER_SECONDS = 60;
const RATE_LIMIT_MESSAGE = 'Too many requests in a short time. Please wait a minute and try again.';

async function rateLimited(env, bindingName, key) {
  const limiter = env[bindingName];
  if (!limiter || typeof limiter.limit !== 'function') {
    console.warn(`fleet-proxy: rate-limit binding ${bindingName} missing — failing open`);
    return false;
  }
  try {
    const { success } = await limiter.limit({ key: String(key) });
    return success === false;
  } catch (err) {
    console.warn(`fleet-proxy: rate-limit binding ${bindingName} threw — failing open:`, err && err.message);
    return false;
  }
}

function rateLimitResponse(cors) {
  const res = jsonError(cors, 429, 'rate_limit_error', RATE_LIMIT_MESSAGE);
  res.headers.set('Retry-After', String(RETRY_AFTER_SECONDS));
  return res;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
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
async function callAnthropic(env, cors, payload) {
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
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
  });
}

// ── Route: POST /ai/dashboard ────────────────────────────────────────────────
// Body contract (unchanged from today): { messages: [ { role:'user', content:[
//   { type:'document', source:{ type:'base64', media_type:'application/pdf', data } },
//   { type:'text', text } ] } ] }
// Only `messages` is taken from the client; model/max_tokens are pinned; the
// content blocks are whitelisted so the proxy can't be used as a general chat.
async function handleDashboard(request, env, cors) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return jsonError(cors, 401, 'authentication_error', 'Sign in to use AI extraction.');

  const user = await verifySupabaseUser(env, token);
  if (!user) return jsonError(cors, 401, 'authentication_error', 'Your session is not valid. Please log in again.');

  // Per signed-in user (20/min). PDF chunks are sent one at a time and each
  // takes 15–60 s, so genuine use stays under 4/min.
  if (await rateLimited(env, 'DASHBOARD_USER_LIMIT', user.id)) return rateLimitResponse(cors);

  const { body, error } = await readJsonBody(request, MAX_BODY_DASHBOARD);
  if (error) return jsonError(cors, 400, 'invalid_request_error', error);

  const messages = sanitiseMessages(body && body.messages, {
    allowDocument: true,
    allowImage: false,
    allowText: true,
  });
  if (!messages) return jsonError(cors, 400, 'invalid_request_error', 'Request must contain one user message with a PDF document and a text instruction.');

  return callAnthropic(env, cors, {
    model: DASHBOARD_MODEL,
    max_tokens: DASHBOARD_MAX_TOKENS,
    messages,
  });
}

// ── Route: POST /ai/driver ───────────────────────────────────────────────────
// Body contract: same shape as today, but ONLY the image block is used — the
// prompt is DRIVER_PROMPT above, whatever the client sends.
async function handleDriver(request, env, cors) {
  const code = (request.headers.get('X-Driver-Code') || '').trim().toUpperCase();
  if (!DRIVER_CODE_RE.test(code)) return jsonError(cors, 401, 'authentication_error', 'Driver code missing or malformed.');

  // Per driver code (15/min), checked before the RPC so one leaked or guessed
  // code can't hammer Supabase either. One photo = one call; a bad minute of
  // retakes and retries is well under this.
  if (await rateLimited(env, 'DRIVER_CODE_LIMIT', code)) return rateLimitResponse(cors);

  const driver = await verifyDriverCode(env, code);
  if (!driver) return jsonError(cors, 401, 'authentication_error', 'Driver code not recognised.');

  const { body, error } = await readJsonBody(request, MAX_BODY_DRIVER);
  if (error) return jsonError(cors, 400, 'invalid_request_error', error);

  const image = extractSingleImage(body && body.messages);
  if (!image) return jsonError(cors, 400, 'invalid_request_error', 'Request must contain one JPEG image of the odometer.');

  return callAnthropic(env, cors, {
    model: DRIVER_MODEL,
    max_tokens: DRIVER_MAX_TOKENS,
    messages: [{ role: 'user', content: [image, { type: 'text', text: DRIVER_PROMPT }] }],
  });
}

// ── Route: POST /ai/compliance ───────────────────────────────────────────────
// Licence-document photo from the signed-in dashboard (Disc Renewal → Scan
// Licences). Auth and throttles are the dashboard's (Supabase JWT, the
// DASHBOARD_* bindings — the per-IP one is applied in the router); the body
// contract is the driver's (ONE image block, everything else dropped, prompt
// pinned above). Response passes straight through like the other routes.
async function handleCompliance(request, env, cors) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return jsonError(cors, 401, 'authentication_error', 'Sign in to scan licence documents.');

  const user = await verifySupabaseUser(env, token);
  if (!user) return jsonError(cors, 401, 'authentication_error', 'Your session is not valid. Please log in again.');

  // Per signed-in user (20/min, shared with PDF extraction). The scanner
  // sends photos one at a time and each read takes several seconds, so a
  // genuine batch stays well under this; the client backs off on 429.
  if (await rateLimited(env, 'DASHBOARD_USER_LIMIT', user.id)) return rateLimitResponse(cors);

  const { body, error } = await readJsonBody(request, MAX_BODY_COMPLIANCE);
  if (error) return jsonError(cors, 400, 'invalid_request_error', error);

  const image = extractSingleImage(body && body.messages);
  if (!image) return jsonError(cors, 400, 'invalid_request_error', 'Request must contain one JPEG image of the licence document.');

  return callAnthropic(env, cors, {
    model: COMPLIANCE_MODEL,
    max_tokens: COMPLIANCE_MAX_TOKENS,
    messages: [{ role: 'user', content: [image, { type: 'text', text: COMPLIANCE_PROMPT }] }],
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
    const known = path === '/ai/dashboard' || path === '/ai/driver' || path === '/ai/compliance';
    // Both signed-in routes share the dashboard throttles (same identity).
    const dashboardLike = path === '/ai/dashboard' || path === '/ai/compliance';

    // {} unless the Origin is on this environment's allowlist.
    const cors = corsHeaders(env, origin);
    const allowed = Object.keys(cors).length > 0;

    // Preflight: only for known routes and allowed origins; otherwise the
    // browser gets no CORS headers and blocks the call.
    if (request.method === 'OPTIONS') {
      if (!known || !allowed) return new Response(null, { status: 404 });
      return new Response(null, { status: 204, headers: cors });
    }

    if (!known) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });

    // Browser calls always carry Origin on a cross-site POST. Anything without
    // an allowed Origin (curl, other sites) is refused outright.
    if (!allowed) return jsonError(cors, 403, 'permission_error', 'Origin not allowed.');

    // Per-IP throttle before anything that costs us a Supabase or Anthropic
    // call. Driver 60/min (SA mobile carriers put many phones behind one
    // address, so this stays loose); dashboard 40/min (also blunts a token
    // spray against Supabase Auth through us).
    const ipBinding = dashboardLike ? 'DASHBOARD_IP_LIMIT' : 'DRIVER_IP_LIMIT';
    if (await rateLimited(env, ipBinding, clientIp(request))) return rateLimitResponse(cors);

    if (!env.ANTHROPIC_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      return jsonError(cors, 500, 'api_error', 'Proxy is not configured.');
    }

    try {
      if (path === '/ai/dashboard') return await handleDashboard(request, env, cors);
      if (path === '/ai/compliance') return await handleCompliance(request, env, cors);
      return await handleDriver(request, env, cors);
    } catch (err) {
      // Never echo internals to the client.
      console.error('fleet-proxy error:', err && err.message);
      return jsonError(cors, 502, 'api_error', 'The AI service could not be reached. Please try again.');
    }
  },
};
