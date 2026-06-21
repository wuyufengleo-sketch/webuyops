-- CRM Audience Studio V1
-- Stores only local operating state: exports + manual customer tags.
-- Source-of-truth customer/order/Respond data remains in the data platform.

create table if not exists public.crm_audience_exports (
  id text primary key,
  preset text not null,
  filters jsonb not null default '{}'::jsonb,
  row_count int not null default 0,
  filename text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists crm_audience_exports_created_idx
  on public.crm_audience_exports (created_at desc);

create table if not exists public.crm_customer_tags (
  canonical_customer_id text primary key,
  customer_name text,
  phone text,
  tags text[] not null default '{}'::text[],
  note text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create index if not exists crm_customer_tags_tags_idx
  on public.crm_customer_tags using gin (tags);

drop trigger if exists crm_customer_tags_updated_at on public.crm_customer_tags;
create trigger crm_customer_tags_updated_at before update on public.crm_customer_tags
  for each row execute function public.set_updated_at();

create table if not exists public.crm_campaigns (
  id text primary key,
  name text not null,
  type text not null default 'reactivation',
  preset text,
  filters jsonb not null default '{}'::jsonb,
  tag_filters jsonb not null default '{}'::jsonb,
  channel text default 'csv',
  audience_count int not null default 0,
  notes text,
  status text not null default 'draft',
  sent_count int not null default 0,
  delivered_count int,
  read_count int,
  reply_count int,
  inquiry_count int,
  responded_count int,
  converted_count int,
  revenue_idr numeric,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  completed_at timestamptz
);

create index if not exists crm_campaigns_created_idx
  on public.crm_campaigns (created_at desc);

alter table public.crm_audience_exports enable row level security;
alter table public.crm_customer_tags enable row level security;
alter table public.crm_campaigns enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='crm_audience_exports' and policyname='crm_audience_exports_read') then
    create policy crm_audience_exports_read on public.crm_audience_exports
      for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='crm_audience_exports' and policyname='crm_audience_exports_write') then
    create policy crm_audience_exports_write on public.crm_audience_exports
      for insert to authenticated with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='crm_customer_tags' and policyname='crm_customer_tags_read') then
    create policy crm_customer_tags_read on public.crm_customer_tags
      for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='crm_customer_tags' and policyname='crm_customer_tags_write') then
    create policy crm_customer_tags_write on public.crm_customer_tags
      for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='crm_campaigns' and policyname='crm_campaigns_read') then
    create policy crm_campaigns_read on public.crm_campaigns
      for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='crm_campaigns' and policyname='crm_campaigns_write') then
    create policy crm_campaigns_write on public.crm_campaigns
      for all to authenticated using (true) with check (true);
  end if;
end $$;
