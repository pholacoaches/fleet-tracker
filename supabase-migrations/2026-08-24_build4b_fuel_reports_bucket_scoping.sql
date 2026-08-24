-- ============================================================================
-- BUILD #4B — fuel reports → database + per-tenant bucket scoping
-- 2026-08-24  (branch: build4b-fuel-db-bucket-scoping)
--
-- PART 1: public.fuel_reports  (RLS on from creation, tenant-isolated)
-- PART 2: storage policies — per-tenant prefix on 'backups' and
--         'odometer-photos' buckets
-- PART 3: driver_page_init returns tenant_id (driver page needs it to
--         prefix its photo uploads)
-- ============================================================================


-- ── PART 1 · fuel_reports ───────────────────────────────────────────────────
-- One row per tenant per statement period. The app's logical key for a report
-- is the period string derived from scheduleDate via getPeriod() — e.g.
-- "07.2026" — and uploads for the same period merge into one report, so
-- (tenant_id, period) is the natural unique key and makes the one-time
-- localStorage migration idempotent (second run conflicts and skips).
-- The report payload keeps the exact JSON shape the app already uses
-- ({id, uploadedAt, scheduleDate, filename, sources, vehicles:[...]}).

-- Soft delete: deleted_at null = live. App deletes are UPDATE deleted_at=now(),
-- never DELETE (the DELETE policy below exists only for a future purge chore).
-- Filtering is APP-SIDE (deleted_at=is.null in the REST query), NOT in the
-- SELECT policy, because the one-time localStorage migration must be able to
-- see that a soft-deleted period EXISTS so it never re-uploads it; a policy
-- that hides deleted rows would make them look absent. Re-uploading a
-- statement for a deleted period resurrects the row (upsert sets
-- deleted_at=null explicitly).

create table public.fuel_reports (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default public.get_my_tenant_id()
             references public.tenants(id),
  period     text not null,
  report     jsonb not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, period)
);

alter table public.fuel_reports enable row level security;

create policy fuel_reports_select_authenticated on public.fuel_reports
  for select to authenticated
  using (tenant_id = public.get_my_tenant_id());

create policy fuel_reports_insert_authenticated on public.fuel_reports
  for insert to authenticated
  with check (tenant_id = public.get_my_tenant_id());

create policy fuel_reports_update_authenticated on public.fuel_reports
  for update to authenticated
  using (tenant_id = public.get_my_tenant_id())
  with check (tenant_id = public.get_my_tenant_id());

-- DELETE is needed (unlike the other six tables) because "Clear Data" must be
-- able to empty the tenant's reports now that the DB is the source of truth.
create policy fuel_reports_delete_authenticated on public.fuel_reports
  for delete to authenticated
  using (tenant_id = public.get_my_tenant_id());

-- Keep updated_at honest on REST upserts (the client can't send now()).
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger fuel_reports_touch_updated_at
  before update on public.fuel_reports
  for each row execute function public.touch_updated_at();


-- ── PART 2a · backups bucket ────────────────────────────────────────────────
-- New object paths are '<tenant_id>/fleetdesk-backup-<ts>.json'. The six
-- existing root-level backups (June 2026, pre-multi-tenant) all belong to
-- Phola Coaches; rather than moving objects (SQL renames on storage.objects
-- orphan the underlying S3 keys), a grandfather clause keeps root-level
-- legacy files visible to Phola only.

drop policy "authenticated can read backups" on storage.objects;
drop policy "authenticated can upload backups" on storage.objects;

create policy backups_select_own_tenant on storage.objects
  for select to authenticated
  using (
    bucket_id = 'backups'
    and (
      (storage.foldername(name))[1] = public.get_my_tenant_id()::text
      or (position('/' in name) = 0
          and public.get_my_tenant_id() = 'afbde0fd-e952-4064-a3e7-dca1187e8e68'::uuid)
    )
  );

create policy backups_insert_own_tenant on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'backups'
    and (storage.foldername(name))[1] = public.get_my_tenant_id()::text
  );


-- ── PART 2b · odometer-photos bucket ────────────────────────────────────────
-- New object paths are '<tenant_id>/<file>'. Applies to admin-side invoice
-- uploads and driver-side odometer photos alike. The two existing objects
-- (one orphan photo + a placeholder) are referenced by no DB row, so no
-- grandfather clause is needed — they simply become invisible.
--
-- NOTE / residual risk (unchanged from today): the anon INSERT policy
-- ("Allow anon uploads to odometer-photos") is left as-is because the driver
-- page uploads with the anon key and an anonymous client has no tenant
-- identity to verify — RLS cannot stop a hostile anon client claiming another
-- tenant's prefix. The tenant-scoped SELECT below is where the real isolation
-- lands: a tenant can only *read/sign* objects under its own prefix.

drop policy "Authenticated users can read odometer photos" on storage.objects;
drop policy "Authenticated uploads to odometer-photos" on storage.objects;

create policy odophotos_select_own_tenant on storage.objects
  for select to authenticated
  using (
    bucket_id = 'odometer-photos'
    and (storage.foldername(name))[1] = public.get_my_tenant_id()::text
  );

create policy odophotos_insert_own_tenant on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'odometer-photos'
    and (storage.foldername(name))[1] = public.get_my_tenant_id()::text
  );


-- ── PART 3 · driver_page_init returns tenant_id ─────────────────────────────
-- The driver page must prefix its photo uploads with its tenant id. The id is
-- not a secret (the page already receives the tenant's branding), and the
-- function still returns null for unknown/inactive codes.

create or replace function public.driver_page_init(p_code text)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_driver record;
  v_today_start timestamptz;
begin
  select name, personal_code, tenant_id
    into v_driver
    from public.drivers
   where personal_code = upper(trim(p_code))
     and active;
  if not found then
    return null;
  end if;
  v_today_start := date_trunc('day', now() at time zone 'Africa/Johannesburg') at time zone 'Africa/Johannesburg';
  return jsonb_build_object(
    'name', v_driver.name,
    'tenant_id', v_driver.tenant_id,
    'submitted_today', exists (
      select 1 from public.odometer_readings
       where driver_code = v_driver.personal_code
         and created_at >= v_today_start),
    'vehicles', coalesce((
      select jsonb_agg(jsonb_build_object('plate', v.plate, 'fleet_no', v.fleet_no) order by v.plate)
        from public.vehicles v
       where v.tenant_id = v_driver.tenant_id
         and v.active), '[]'::jsonb),
    'branding', (
      select jsonb_build_object(
        'display_name', t.display_name,
        'tagline', t.tagline,
        'logo_url', t.logo_url,
        'hero_image_url', t.hero_image_url,
        'accent_color', t.accent_color)
        from public.tenants t
       where t.id = v_driver.tenant_id)
  );
end;
$function$;
