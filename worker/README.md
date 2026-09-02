# fleet-proxy Worker

The Cloudflare Worker that fronts the Anthropic API for FleetDesk. Source now
lives here (`worker.js`) — before audit fix #1 it existed only in the
Cloudflare dashboard.

## What it does

| Route | Who | Auth | What Anthropic sees |
|---|---|---|---|
| `POST /ai/dashboard` | `index.html` fuel-statement PDF extraction | `Authorization: Bearer <Supabase access token>` — verified with `GET /auth/v1/user` on every call | client's PDF chunk + prompt, model + max_tokens pinned |
| `POST /ai/driver` | `driver.html` odometer photo read | `X-Driver-Code: AAA-0000` — validated with the `driver_page_init` RPC (null = unknown/inactive) | client's JPEG only; prompt, model and max_tokens pinned |
| anything else (`/`, `/login`, `/auth/*`) | — | — | **404** |

Pinned: `claude-sonnet-4-6`, `max_tokens` 4000 (dashboard) / 100 (driver) —
the same values the app sends today. The client's `model`/`max_tokens` are
ignored.

CORS is environment-based (since 2026-09-02, see "Environments" below).
Production allows `https://pholacoaches.github.io` only. Requests without an
allowed `Origin` get 403.

## Environments

The allowlist is the `ALLOWED_ORIGINS` var in `wrangler.jsonc` (comma-separated).
`worker.js` falls back to the production origin alone if the var is missing.

| Command | Worker | URL | `ALLOWED_ORIGINS` |
|---|---|---|---|
| `wrangler deploy` | `fleet-proxy` (production) | `https://fleet-proxy.gjtucker83.workers.dev` | `https://pholacoaches.github.io` |
| `wrangler deploy --env dev` | `fleet-proxy-dev` | `https://fleet-proxy-dev.gjtucker83.workers.dev` | production + `http://localhost:8787` + `http://localhost:8377` |

Never add localhost / 127.0.0.1 to the production block. Wrangler does not
inherit `vars` into named environments, so the `dev` block repeats the
Supabase vars — keep both in step.

`fleet-proxy-dev` is a separate Worker, so it needs its own
`ANTHROPIC_API_KEY` secret (Cloudflare dashboard → Workers → fleet-proxy-dev →
Settings → Variables and Secrets; `wrangler secret put` via the `!` shell has
uploaded an empty value before). Until it is set, the dev Worker answers
preflights correctly but every POST returns 500 "Proxy is not configured".
To test the app locally against it, point the two fetch URLs in `index.html` /
`driver.html` at `fleet-proxy-dev` temporarily — never commit that change.

Errors come back in Anthropic's shape (`{ error: { type, message } }`) so the
app's existing `data.error.message` handling keeps working.

## Deploy order (zero downtime)

The *old* Worker proxies any path and ignores extra headers, so:

1. Ship the app change first (new paths + headers — see below). It works
   against the old Worker unchanged.
2. Then deploy this Worker: `cd worker && wrangler deploy`.
3. Then delete the legacy secrets (below) and rotate the Anthropic key.

## App-side changes (applied 2026-08-25, sw v56)

`index.html` `extractChunkWithAI` (~line 2165):

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

`driver.html` `readOdometerWithAI` (~line 472):

```js
const response=await fetch('https://fleet-proxy.gjtucker83.workers.dev/ai/driver',{
  method:'POST',
  headers:{'Content-Type':'application/json','X-Driver-Code':driver.personal_code},
  body:JSON.stringify({messages:[{role:'user',content:[
    {type:'image',source:{type:'base64',media_type:'image/jpeg',data:base64}}
  ]}]})
});
```

(`model`, `max_tokens` and the driver prompt can be dropped from the client —
the Worker ignores them.)

## One-time cleanup after deploy

Wrangler keeps existing secrets across deploys, so the six legacy ones must be
deleted explicitly (they belonged to the removed `/login` and `/auth/*` OTP
routes):

```
wrangler secret delete APPROVED_EMAILS      --name fleet-proxy
wrangler secret delete FLEET_USER_1_EMAIL   --name fleet-proxy
wrangler secret delete FLEET_USER_1_PASSWORD --name fleet-proxy
wrangler secret delete FLEET_USER_2_EMAIL   --name fleet-proxy
wrangler secret delete FLEET_USER_2_PASSWORD --name fleet-proxy
wrangler secret delete FROM_EMAIL           --name fleet-proxy
wrangler secret delete RESEND_API_KEY       --name fleet-proxy
```

Then rotate the Anthropic key (it has been reachable through an open relay
since June):

```
wrangler secret put ANTHROPIC_API_KEY --name fleet-proxy
```

and set a monthly spend limit in the Anthropic console.

## Rate limiting

Two layers, both optional but recommended before go-live:

- **Per driver code** — uncomment the `ratelimits` block in `wrangler.jsonc`
  (Workers Rate Limiting binding). `worker.js` picks it up automatically.
- **Per IP, for code guessing** — Cloudflare dashboard → Security → WAF →
  Rate limiting rules: e.g. 30 requests / minute per IP to
  `fleet-proxy.gjtucker83.workers.dev`. This also covers the Supabase RPC
  guessing surface only if the driver page is moved behind the Worker, so
  treat it as the first step of audit item #8.

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
