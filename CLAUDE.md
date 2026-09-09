# FleetDesk — Claude Code rules

## What this is
Multi-tenant fleet management PWA. Live on GitHub Pages
(pholacoaches.github.io/fleet-tracker). Supabase backend (RLS on all
data tables). Cloudflare Worker fleet-proxy for AI routes.
Phone breakpoint 600px.
Greg is a non-technical solo builder — plain English, short answers.
Session state lives in the planning chat's knowledge file, not here —
this file is stable rules only.

## The app is SEVEN files — back up all seven before any change
index.html (~211KB, single-file app), driver.html, sw.js,
manifest.json, esc.js, monitor.js, sentry.bundle.min.js.
Backups go to "..\fleet tracker AUDIT\AUDIT_<date>_<task>\" —
NEVER inside the repo. Check the date with Get-Date first.

## Workflow — non-negotiable
- Feature branch first. Read and report before editing. Show diffs.
- Small commits, one problem at a time. Greg tests localhost between
  blocks. STOP and wait for Greg's go before editing and before
  merge/push.
- Never merge or push without approval. Never delete / reset /
  discard / force / clean without asking (exception: Temp\claude
  scratchpad).
- Never change data logic, Supabase calls, date maths or alert
  thresholds unless that IS the task.
- STANDING CLAUSE: report security holes, data leaks, dead code,
  design weaknesses noticed — even out of scope. Never fix silently.

## Release rule
Bump BOTH sw.js const CACHE and monitor.js FLEETDESK_RELEASE to the
same fleetdesk-vNN on every deploy.

## Git
- Push: git -c credential.https://github.com.helper= -c credential.https://github.com.helper=manager push origin main
- Commit messages / commands over ~1015 bytes: scratchpad file,
  git commit -q -F <file>.

## Gotchas
- Edits first, external script writes LAST (Edit tool caches file
  state and can silently revert a script's change).
- No-break spaces: write as \u escapes via a script file.
- wrangler secret put uploads EMPTY values — secrets go in via the
  Cloudflare dashboard only.
- Trust Get-Date over the planning chat if dates disagree.
- Windows line endings: inserts into index.html may take 2-3 tries.
- Local server must start from inside the project folder.
- PATCH calls: use Prefer: return=representation, treat empty array
  as failure (204 lies).
