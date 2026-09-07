# fleet-proxy Worker

The Cloudflare Worker that fronts the Anthropic API for FleetDesk. Source
lives here (`worker.js`); before audit fix #1 (2026-08-25) it existed only in
the Cloudflare dashboard.

## What it does

| Route | Who | Auth | What Anthropic sees |
|---|---|---|---|
| `POST /ai/dashboard` | `index.html` fuel-statement PDF extraction | `Authorization: Bearer <Supabase access token>` — verified with `GET /auth/v1/user` on every call | client's PDF chunk + prompt, model + max_tokens pinned |
| `POST /ai/driver` | `driver.html` odometer photo read | `X-Driver-Code: AAA-0000` — validated with the `driver_page_init` RPC (null = unknown/inactive) | client's JPEG only; prompt, model and max_tokens pinned |
| `POST /ai/compliance` | `index.html` licence-document photo read (Disc Renewal → Scan Licences, 2026-09-04) | same as `/ai/dashboard` (Supabase bearer token) | client's JPEG only; prompt, model and max_tokens pinned |
| `GET /monitor/test?key=…` | Greg, in a browser | `SENTRY_TEST_KEY` secret (404 otherwise) | nothing — sends a deliberate test error to Sentry (see "Error monitoring") |
| anything else (`/`, `/login`, `/auth/*`) | — | — | **404** |

Pinned: `claude-sonnet-4-6`, `max_tokens` 4000 (dashboard) / 100 (driver).
The compliance route is the exception since 2026-09-04 (fix-scan-accuracy):
`claude-opus-5`, `max_tokens` 1500 (thinking + answer), `output_config`
effort `low` + JSON-schema structured output (all fields nullable, dates
forced to YYYY-MM-DD). Moved on evidence from real photos — Sonnet returned
the receipt date as the COF expiry and the "Vehicle register number" as the
plate on 2 of 3 documents. The client's `model`/`max_tokens` are ignored on
every route. The office approves every scanned value in a table before it
is saved. Compliance Stage 2 (same day) taught the prompt single-circle
documents (trailers, light vehicles: disc expiry only, COF and operator
card null) and that a "Roadworthy test date / Date of test" is never an
expiry.

CORS is environment-based (see "Environments"). Production allows
`https://pholacoaches.github.io` only. Requests without an allowed `Origin`
get 403.

Errors come back in Anthropic's shape (`{ error: { type, message } }`) so the
app's `data.error.message` handling keeps working.

## Environments

The allowlist is the `ALLOWED_ORIGINS` var in `wrangler.jsonc` (comma-separated).
`worker.js` falls back to the production origin alone if the var is missing.

| Command | Worker | URL | `ALLOWED_ORIGINS` |
|---|---|---|---|
| `wrangler deploy --env ""` | `fleet-proxy` (production) | `https://fleet-proxy.gjtucker83.workers.dev` | `https://pholacoaches.github.io` |
| `wrangler deploy --env dev` | `fleet-proxy-dev` | `https://fleet-proxy-dev.gjtucker83.workers.dev` | production + `http://localhost:8787` + `http://localhost:8377` |

(`--env ""` is the top-level config; the empty string only silences wrangler's
multi-environment warning.)

Never add localhost / 127.0.0.1 to the production block. Wrangler does not
inherit `vars` or bindings into named environments, so the `dev` block repeats
the Supabase vars and the `ratelimits` — keep both in step.

`fleet-proxy-dev` is a separate Worker, so it needs its own
`ANTHROPIC_API_KEY` secret (Cloudflare dashboard → Workers → fleet-proxy-dev →
Settings → Variables and Secrets; `wrangler secret put` via the `!` shell has
uploaded an empty value before). Until it is set, the dev Worker answers
preflights, the 403/404 paths and the per-IP throttle correctly, but every
authenticated POST returns 500 "Proxy is not configured". To test the app
locally against it, point the two fetch URLs in `index.html` / `driver.html`
at `fleet-proxy-dev` temporarily — never commit that change.

## Rate limiting (2026-09-03)

Workers Rate Limiting bindings, declared in `wrangler.jsonc` for both
environments and deployed by wrangler — nothing to configure in the
dashboard. The binding is free and needs no storage. Its window is 10 or 60 s
only and counters are per Cloudflare location, so a limit is approximate;
that is fine for a burst guard. The Anthropic monthly spend cap (set) remains
the hard backstop.

| Binding | Route | Key | Limit | Where checked |
|---|---|---|---|---|
| `DRIVER_IP_LIMIT` | `/ai/driver` | client IP | 60 / min | router, before any Supabase call |
| `DRIVER_CODE_LIMIT` | `/ai/driver` | driver code | 15 / min | handler, after the regex, before the RPC |
| `DASHBOARD_IP_LIMIT` | `/ai/dashboard`, `/ai/compliance` | client IP | 40 / min | router, before the token check |
| `DASHBOARD_USER_LIMIT` | `/ai/dashboard`, `/ai/compliance` | Supabase user id | 20 / min | handler, after token verification |

Sizing: one driver photo is one call, so 15/min covers a bad minute of
retakes and retries several times over; SA mobile carriers put many phones
behind one address, so the driver per-IP limit stays loose. Dashboard PDF
chunks are sent one at a time and each takes 15–60 s, so real use is under
4/min. The licence scanner shares the dashboard bindings (same signed-in
identity) and also sends photos strictly one at a time, each taking several
seconds, so a batch of 30+ stays under the per-user limit; on a 429 it waits
out the window once and retries that photo, then leaves a Retry button.

Over the limit → `429` with `Retry-After: 60` and
`{ error: { type: "rate_limit_error", message: "Too many requests in a short time. Please wait a minute and try again." } }`.
Anthropic's own 429 passes through in the same shape. Both pages show their
own calm message on a 429 (driver: status line + Retry, no strike; dashboard:
the upload aborts before anything is saved).

**Fail open:** if a binding is missing or its `limit()` call throws, the
Worker logs a warning and lets the request through. Throttling must never
take real users down.

A per-IP WAF rate-limiting rule is **not** possible on a `*.workers.dev`
hostname (WAF rules attach to a zone you own); the per-IP bindings above
replace that idea. A per-tenant daily spend ceiling would need a Durable
Object — parked on the SaaS-scaling list.

## App-side contract

`index.html` `extractChunkWithAI`:

```js
const response=await fetch('https://fleet-proxy.gjtucker83.workers.dev/ai/dashboard',{
  method:'POST',
  headers:{'Content-Type':'application/json','Authorization':'Bearer '+authToken()},
  body:JSON.stringify({messages:[{role:'user',content:[
    {type:'document',source:{type:'base64',media_type:'application/pdf',data:base64Data}},
    {type:'text',text:prompt}
  ]}]})
});
```

`driver.html` `readOdometerWithAI`:

```js
const response=await fetch('https://fleet-proxy.gjtucker83.workers.dev/ai/driver',{
  method:'POST',
  headers:{'Content-Type':'application/json','X-Driver-Code':driver.personal_code},
  body:JSON.stringify({messages:[{role:'user',content:[
    {type:'image',source:{type:'base64',media_type:'image/jpeg',data:base64}}
  ]}]})
});
```

`index.html` `readLicenceWithAI` (2026-09-04) — dashboard auth, driver body:

```js
const response=await fetch('https://fleet-proxy.gjtucker83.workers.dev/ai/compliance',{
  method:'POST',
  headers:{'Content-Type':'application/json','Authorization':'Bearer '+authToken()},
  body:JSON.stringify({messages:[{role:'user',content:[
    {type:'image',source:{type:'base64',media_type:'image/jpeg',data:base64}}
  ]}]})
});
```

Answer (text block, strict JSON, every field nullable — the app blanks and
flags anything that is not `YYYY-MM-DD`):

```json
{"plate":"RPF655W","disc_expiry":"2027-03-31","cof_expiry":"2026-09-30",
 "op_licence_expiry":"2028-01-15","disc_no":null,"op_licence_no":null,
 "make_model":null,"confidence":"high"}
```

## Error monitoring (Sentry, 2026-09-07)

The Worker reports to the **fleetdesk-worker** Sentry project (EU region,
platform Cloudflare Workers) — a separate project from the app's
**fleetdesk** one, so a Worker problem and a browser problem never mix.
Package: `@sentry/cloudflare` (pinned in `package.json`; `npm install` in
this folder once after cloning, wrangler bundles it). Errors only: no
tracing, no logs, no breadcrumbs, no release-health sessions.

| Setting | Where | Value |
|---|---|---|
| `SENTRY_DSN` | `wrangler.jsonc` var, both env blocks | the project DSN. A DSN is a write-only address — it lets a client *send* events and nothing else — so it is a plain var like the app's in `monitor.js`. Remove it and monitoring is off; the Worker is unaffected. |
| `SENTRY_ENVIRONMENT` | `wrangler.jsonc` var, per env block | `production` (fleet-proxy) / `development` (fleet-proxy-dev) |
| release | automatic | `fleet-proxy@<Cloudflare version id>` from the `version_metadata` binding. Nothing to bump. The id matches Workers → fleet-proxy → **Versions** in the Cloudflare dashboard. The app's `fleetdesk-vNN` release belongs to the other Sentry project; line the two up by time, or by the release id on the Versions page. |
| `SENTRY_TEST_KEY` | dashboard **secret** on each Worker | enables `GET /monitor/test`. Not in any file. |
| `nodejs_als` | `compatibility_flags` | the SDK needs `AsyncLocalStorage` to keep each request's tags separate. Narrowest flag that works (only `node:async_hooks` is bundled). |

**What is reported**

| Signal | Level | Message | Tags |
|---|---|---|---|
| anything thrown inside a route handler (the router's catch; client still gets the same 502) | error | error class + message | `route`, `upstream` if it happened during the Anthropic call |
| Anthropic answered non-2xx | error (their 429: warning) | `anthropic <status> <error type>` e.g. `anthropic 529 overloaded_error` | `route`, `upstream=anthropic`, `http_status` |
| Supabase Auth / RPC unreachable or 5xx during a token or driver-code check | warning | `supabase auth unreachable`, `supabase rpc 503` | `route`, `upstream=supabase`, `http_status` |
| our own 429 | info | `rate limited: <binding>` | `route`, `limiter`, `http_status=429` — at most one per limiter per minute per Worker instance, so a flood cannot drain the (org-wide) Sentry quota |
| `/monitor/test` | error | `FleetDesk Worker monitoring test — this error is deliberate` | `route=other`, `test=true` |

`route` is `pdf` (/ai/dashboard), `odometer` (/ai/driver), `compliance`
(/ai/compliance) or `other`. `tenant` (the tenant UUID, never the name) is
added on the driver route only — `driver_page_init` returns it. The signed-in
routes only see the Supabase user, whose record carries no tenant id; adding
it would cost an extra Supabase call per request, so it is left out.

**What Sentry never receives.** Image or PDF bytes, base64, prompt text, AI
answers, driver codes, plates, API keys, bearer tokens, request or response
bodies, URLs, query strings, cookies, IP addresses, or any header except
`User-Agent`. Enforced twice: the SDK's default integrations that attach
request bodies / URLs / headers / fetch breadcrumbs are not installed
(explicit list in `sentryOptions`), and `beforeSend` (`scrubEvent`) drops
`request`, `user`, `breadcrumbs`, `extra`, `spans`, all contexts except
`trace`/`runtime`/`cloud_resource`, every tag not on its allow-list, and
redacts base64-looking runs (40+ chars), `sk-ant-…`, `Bearer …` and
`AAA-0000` patterns in any message before cutting it to 300 characters. If
the scrub itself throws, the event is dropped rather than sent. Verified
locally on 2026-09-07 by pointing `SENTRY_DSN` at a local catcher and
replaying the driver route with a fake image: the payload held the message,
tags, stack and User-Agent only.

**Testing delivery.** Set `SENTRY_TEST_KEY` (a random string, 16+ chars) as
a secret on the Worker, then open in a browser:

```
https://fleet-proxy-dev.gjtucker83.workers.dev/monitor/test?key=<the key>
https://fleet-proxy.gjtucker83.workers.dev/monitor/test?key=<the key>
```

A plain-text page confirms the environment, release and event id; the event
appears in the fleetdesk-worker project within a minute. The route makes no
Supabase or Anthropic call, sits behind the dashboard per-IP throttle, only
answers GET, and is a plain 404 unless the secret is set and matches
(constant-time compare). The key is only ever in the query string, which
Sentry never receives.

## Secrets

`ANTHROPIC_API_KEY` and `SENTRY_TEST_KEY` (see "Error monitoring") are the
only secrets. The API key was rotated on 2026-08-25 and the seven legacy
secrets from the removed `/login` and `/auth/*` routes were deleted the same
day. Set or rotate in the Cloudflare dashboard, not via `wrangler secret put`
from a non-TTY shell (see above).

## Local test

```
cd worker
echo ANTHROPIC_API_KEY=sk-ant-... > .dev.vars      # never commit this file
wrangler dev                                       # serves on http://localhost:8787
```

Expected without credentials:

```
curl -i -X POST http://localhost:8787/               -H "Origin: https://pholacoaches.github.io"   # 404
curl -i -X POST http://localhost:8787/login          -H "Origin: https://pholacoaches.github.io"   # 404
curl -i -X POST http://localhost:8787/ai/dashboard   -H "Origin: https://evil.example"             # 403
curl -i -X POST http://localhost:8787/ai/dashboard   -H "Origin: https://pholacoaches.github.io"   # 401
curl -i -X POST http://localhost:8787/ai/driver      -H "Origin: https://pholacoaches.github.io" -H "X-Driver-Code: ZZZ-0000"   # 401
curl -i -X POST http://localhost:8787/ai/compliance  -H "Origin: https://pholacoaches.github.io"   # 401
```

Rate-limit check against a deployed Worker (per IP; no credentials needed):
60 POSTs to `/ai/dashboard` with the production Origin **over one kept-alive
connection** (pass the URL to a single `curl` invocation many times) — about
the first 41 return 401, the rest 429 with `Retry-After: 60`; a minute later
401 again. Counters live on the machine that served the request and sync in
the background, so one-request-per-connection loops spread across machines
and may never trip — that is the documented eventual consistency, not a bug.
Observed 2026-09-03: limits trip one request late (41st/62nd/16th).
