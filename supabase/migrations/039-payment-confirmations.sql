-- ============================================================================
--  Sprint — CS Payment Confirmation Link
--
--  Finance generates a link from DP Collection when a customer's transfer
--  proof arrives (e.g. via Skype). CS opens the link (in-app, authenticated —
--  no service-role bypass needed) and confirms destination / tour / pax count
--  / visa type, then gets a suggested document checklist to share with the
--  customer's WhatsApp group (created manually by CS).
-- ============================================================================

create table public.payment_confirmations (
  id              uuid primary key default gen_random_uuid(),  -- also the link token
  order_ref       text references public.package_orders(id),  -- 'ord-'||order_id
  bkg_no          text,
  tour_code       text,
  tour_name       text,
  departure_date  date,
  contact_name    text,
  destination     text,
  pax_count       int,
  visa_type       text,        -- 'GROUP VISA' | 'INDIVIDUAL VISA'
  visa_country    text,
  doc_checklist   jsonb,       -- finalized [{key,label}] CS will ask the customer for
  status          text not null default 'PENDING',  -- PENDING | CONFIRMED
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  confirmed_by    uuid references auth.users(id),
  confirmed_at    timestamptz
);

create index payment_confirmations_order_idx on public.payment_confirmations(order_ref);

alter table public.payment_confirmations enable row level security;
create policy "auth read payment_confirmations"  on public.payment_confirmations for select using (auth.role() = 'authenticated');
create policy "auth write payment_confirmations" on public.payment_confirmations for all    using (auth.role() = 'authenticated');

alter publication supabase_realtime add table public.payment_confirmations;
