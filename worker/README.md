# fleet-proxy Worker

The Cloudflare Worker that fronts the Anthropic API for FleetDesk. Source
lives here (`worker.js`); before audit fix #1 (2026-08-25) it existed only in
the Cloudflare dashboard.

## What it does

| Route | Who | Auth | What Anthropic sees |
|---|---|---|---|
| `POST /ai/dashboard` | `index.html` fuel-statement PDF extraction | `Authorization: Bearer <Supabase access token>` — verified with `GET /auth/v1/user` on every call | client's PDF chunk + prompt, model + max_tokens pinned |
| `POST /ai/driver` | `driver.html` odometer photo read | `X-Driver-Code: AAA-0000` — validated with the `driver_page_init` RPC (null = unknown/inactive) | client's JPEG only; prompt, model and max_tokens pinned |
| anything else (`/`, `/login`, `/auth/*`) | — | — | **404** |

Pinned: `claude-sonnet-4-6`, `max_tokens` 4000 (dashboard) / 100 (driver).
The client's `model`/`max_tokens` are ignored.

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
| `DASHBOARD_IP_LIMIT` | `/ai/dashboard` | client IP | 40 / min | router, before the token check |
| `DASHBOARD_USER_LIMIT` | `/ai/dashboard` | Supabase user id | 20 / min | handler, after token verification |

Sizing: one driver photo is one call, so 15/min covers a bad minute of
retakes and retries several times over; SA mobile carriers put many phones
behind one address, so the driver per-IP limit stays loose. Dashboard PDF
chunks are sent one at a time and each takes 15–60 s, so real use is under
4/min.

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

## Secrets

`ANTHROPIC_API_KEY` is the only secret. It was rotated on 2026-08-25 and the
seven legacy secrets from the removed `/login` and `/auth/*` routes were
deleted the same day. Set or rotate it in the Cloudflare dashboard, not via
`wrangler secret put` from a non-TTY shell (see above).

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
```

Rate-limit check against a deployed Worker (per IP; no credentials needed):
60 POSTs to `/ai/dashboard` with the production Origin **over one kept-alive
connection** (pass the URL to a single `curl` invocation many times) — about
the first 41 return 401, the rest 429 with `Retry-After: 60`; a minute later
401 again. Counters live on the machine that served the request and sync in
the background, so one-request-per-connection loops spread across machines
and may never trip — that is the documented eventual consistency, not a bug.
Observed 2026-09-03: limits trip one request late (41st/62nd/16th).
