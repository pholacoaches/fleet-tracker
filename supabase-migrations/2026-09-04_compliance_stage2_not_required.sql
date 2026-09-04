-- ============================================================================
-- COMPLIANCE STAGE 2 — per-item "Not required" flags
-- 2026-09-04  (branch: compliance-stage2)
-- Applied as named migration: compliance_stage2_not_required_flags
--
-- A trailer has no COF or operating licence; a light vehicle has no operator
-- card. Each of the three compliance items can be marked Not required per
-- vehicle: grey "Not required" chip in place of the date, never counted as
-- Not set, never alerts. Any stored date is kept (the flag hides it, so the
-- choice is reversible). RLS policies are row-level and unchanged; the
-- scanner's non-blank-only save never touches these columns.
-- ============================================================================

alter table public.vehicle_compliance
  add column if not exists licence_disc_not_required boolean not null default false,
  add column if not exists cof_not_required boolean not null default false,
  add column if not exists operating_licence_not_required boolean not null default false;

comment on column public.vehicle_compliance.licence_disc_not_required is 'Stage 2: item marked Not required for this vehicle — hidden from alerts and counts';
comment on column public.vehicle_compliance.cof_not_required is 'Stage 2: item marked Not required for this vehicle — hidden from alerts and counts';
comment on column public.vehicle_compliance.operating_licence_not_required is 'Stage 2: item marked Not required for this vehicle — hidden from alerts and counts';
