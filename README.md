# fleet-tracker

## Error monitoring (Sentry)

Both pages (`index.html` dashboard, `driver.html` driver page) load a
self-hosted copy of the Sentry browser SDK (`sentry.bundle.min.js`,
@sentry/browser 10.73.0, errors-only bundle) followed by `monitor.js`, which
holds the init, the privacy scrub, the failed-fetch reporter and the console
helpers. Sentry project: `fleetdesk-web` (EU region).

**Six app files** now make up the deployable app: `index.html`, `driver.html`,
`sw.js`, `manifest.json`, `esc.js`, `monitor.js` (plus the vendored
`sentry.bundle.min.js`). Back all of them up before a change.

**Release bump rule.** On every deploy bump BOTH `const CACHE` in `sw.js` and
`FLEETDESK_RELEASE` in `monitor.js` to the same `fleetdesk-vNN`. The release
is what ties a Sentry error to a build.

**What Sentry receives:** the error message and stack trace (file names
without query string or hash), page (`dashboard` / `driver`), tenant UUID,
environment (`production` / `local`), release, browser and OS from the
User-Agent, and for failed API calls the method, shortened path and HTTP
status (for example `supabase PATCH /rest/v1/vehicles returned 401`).

**What Sentry never receives:** driver names, phone numbers, plates, e-mail
addresses, photos, odometer readings, auth tokens or API keys, request or
response bodies, URL query strings or hashes, breadcrumbs, IP addresses,
session-replay or performance data. If a scrub step fails the event is
dropped rather than sent unscrubbed.

**Test hook.** Open the browser console (F12) on either page and type:

```js
FleetDesk.testSentry()             // throws a genuine uncaught error
FleetDesk.testSentry('rejection')  // fires an unhandled promise rejection
```

Each returns a line such as
`Sent: "FleetDesk test error (dashboard) k3j9x2" | environment=local release=fleetdesk-v73 page=dashboard`.
The same message should appear in the Sentry Issues list within a minute,
tagged with that page, environment and release. If the line starts with
`NOT sent`, the SDK file did not load (check the Network tab for
`sentry.bundle.min.js`).

**Other helpers** (used by the pages, available in the console):
`FleetDesk.setTenant(uuid)` tags later events with the tenant;
`FleetDesk.reportError(message, {endpoint, status})` records an app-detected
failure that is not an exception.
