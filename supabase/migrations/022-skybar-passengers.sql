-- 022 — Skybar passenger mirror table
--
-- Mirrors wt_order_passenger from Skybar so the Visa drill-down (and any
-- future passenger-aware page) can read passport info, photo URLs and
-- nationality without re-hitting MySQL. Populated by api/sync-skybar.js on
-- every cron run. Existing manifest_passengers (sourced from Google Sheets)
-- is left untouched — downstream pages join the two as needed.

create table if not exists public.skybar_passengers (
  id              text primary key,                -- 'sbp-' || skybar_order_passenger_id
  order_id        bigint not null,                 -- wt_order.id
  bkg_no          text,                            -- BK00xxxx (derived from order_id, matches package_orders.bkg_no)
  passenger_id    bigint,                          -- wt_passenger.id (may repeat across orders)
  name            text,
  title           text,                            -- M/F/MR/MRS/MISS — Skybar mixes both
  passport_no     text,
  gender          text,
  birthday        date,
  nationality     text,
  issue_date      date,
  expiry_date     date,
  phone           text,
  room_type       text,
  photo_url       text,                            -- raw Skybar photo URL (may need signing)
  upload_passport_time timestamptz,
  passenger_status int,
  passenger_remark text,
  synced_at       timestamptz not null default now()
);

create index if not exists skybar_passengers_order_idx     on public.skybar_passengers (order_id);
create index if not exists skybar_passengers_bk_idx        on public.skybar_passengers (bkg_no);
create index if not exists skybar_passengers_passport_idx  on public.skybar_passengers (passport_no);
create index if not exists skybar_passengers_name_idx      on public.skybar_passengers (name);
create index if not exists skybar_passengers_expiry_idx    on public.skybar_passengers (expiry_date);

alter table public.skybar_passengers enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'skybar_passengers' and policyname = 'skybar_passengers_read') then
    create policy skybar_passengers_read on public.skybar_passengers for select to authenticated using (true);
  end if;
end $$;
