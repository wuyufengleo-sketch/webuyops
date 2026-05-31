-- ============================================================================
--  Sprint 11 — Staff phone directory
--
--  Internal staff (sales TCs, CS handlers, OPS) name → WhatsApp phone, used
--  by the BK Group modal so OPS can copy each member's number in one click
--  while building the WA group manually. Phone format = E.164 without +
--  (e.g. 6281234567890) so wa.me links work directly.
--
--  Seed once Leo sends the name list — until then the modal shows
--  "⚠️ phone not on file" with an "+ add" prompt.
-- ============================================================================

create table if not exists public.staff_contacts (
  name text primary key,                     -- as it appears in package_orders.salesman / cs_records.tl
  role text,                                 -- 'Sales' | 'CS' | 'OPS' | 'TL' | 'Admin'
  wa_phone text,                             -- E.164 sans + (e.g. 6281234567890)
  lark_id text,                              -- optional, for cross-team mentions
  active boolean default true,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

do $$ begin
  drop trigger if exists staff_contacts_updated_at on public.staff_contacts;
  create trigger staff_contacts_updated_at before update on public.staff_contacts
    for each row execute function public.set_updated_at();
end $$;

alter table public.staff_contacts enable row level security;
drop policy if exists "auth read"  on public.staff_contacts;
drop policy if exists "auth write" on public.staff_contacts;
create policy "auth read"  on public.staff_contacts for select using (auth.role()='authenticated');
create policy "auth write" on public.staff_contacts for all    using (auth.role()='authenticated') with check (auth.role()='authenticated');

do $$ begin alter publication supabase_realtime add table public.staff_contacts; exception when duplicate_object then null; end $$;
