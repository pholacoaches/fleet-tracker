-- Applied to phola-fleet (wlwwzbyuchsonwugqhww) on 2026-08-13 as migration
-- "approved_readings_per_vehicle_rpc". Kept here for record.
--
-- Last N approved odometer readings per plate (default 10).
-- SECURITY INVOKER (default): RLS on odometer_readings still applies, so only
-- authenticated dashboard users get rows back.
create or replace function public.approved_readings_per_vehicle(p_limit int default 10)
returns setof public.odometer_readings
language sql
stable
as $$
  select r.*
  from (select distinct plate from public.odometer_readings where status = 'approved') p
  cross join lateral (
    select o.*
    from public.odometer_readings o
    where o.plate = p.plate and o.status = 'approved'
    order by o.created_at desc
    limit greatest(1, least(p_limit, 50))
  ) r
  order by r.plate, r.created_at desc;
$$;
