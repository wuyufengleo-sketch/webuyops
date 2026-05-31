-- ============================================================================
--  Sprint 11 — BK WhatsApp Group registry
--
--  One row per BK number that has (or should have) a WhatsApp group with
--  sales + CS + customer. Lives in its own table so it's durable across
--  Skybar sync prunes, and so the "groups missing" reconciler can scan it
--  cheaply.
--
--  wa_link stays nullable — a NULL row means "BK is on file as needing a
--  group, but it hasn't been created yet". Compliance monitor counts NULLs.
--
--  Run in the Supabase SQL Editor before deploying.
-- ============================================================================

create table if not exists public.bk_groups (
  bkg_no text primary key,                   -- = package_orders.bkg_no ("BK00xxxx")
  wa_link text,                              -- https://chat.whatsapp.com/...
  customer_name text,                        -- snapshot at create-time
  tour_code text,                            -- snapshot
  sales_name text,                           -- snapshot
  cs_name text,                              -- the CS who created the group
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

do $$ begin
  drop trigger if exists bk_groups_updated_at on public.bk_groups;
  create trigger bk_groups_updated_at before update on public.bk_groups
    for each row execute function public.set_updated_at();
end $$;

alter table public.bk_groups enable row level security;
drop policy if exists "auth read"  on public.bk_groups;
drop policy if exists "auth write" on public.bk_groups;
create policy "auth read"  on public.bk_groups for select using (auth.role()='authenticated');
create policy "auth write" on public.bk_groups for all    using (auth.role()='authenticated') with check (auth.role()='authenticated');

do $$ begin alter publication supabase_realtime add table public.bk_groups; exception when duplicate_object then null; end $$;
