-- Build #4a (2026-08-19): driver_page_init also returns the driver's tenant
-- branding so driver.html can brand per tenant. Everything else unchanged.
-- Applied to production via MCP apply_migration 'driver_page_init_branding'.
--
-- Also applied as plain data updates (not DDL, recorded here for the audit trail):
--   update tenants set hero_image_url='savika-hero.jpg', accent_color='#DE712C'
--    where id='35f1bb75-839b-4625-b6af-17ca3193d996';  -- Savika Special Ops

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
