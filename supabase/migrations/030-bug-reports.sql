-- 030 — Bug Reports table for in-app bug tracking
--
-- Teams (Operation, Visa, Document, CS, Ticketing) submit bugs through the OPS
-- app. Each report goes through a lifecycle:
--   reported → analyzing → waiting_approval → in_progress → fixed → verified
-- Leo receives a Lark notification on submission and when approval is needed.

create table if not exists public.bug_reports (
  id            bigint generated always as identity primary key,
  department    text not null check (department in ('Operation','Visa','Document','CS','Ticketing','Finance','Other')),
  reporter_id   uuid references auth.users(id),
  reporter_name text not null,
  found_at      timestamptz not null default now(),
  title         text not null,
  details       text not null,
  page_module   text,
  steps         text,
  actual_result text,
  expected_result text,
  impact        text check (impact in ('Low','Medium','High','Critical')),
  urgency       text check (urgency in ('Low','Medium','High','Critical')),
  status        text not null default 'reported' check (status in ('reported','analyzing','waiting_approval','in_progress','fixed','verified','rejected')),
  attachment_url text,
  notes         text,
  assigned_to   text,
  resolved_at   timestamptz,
  resolved_by   uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id)
);

create trigger bug_reports_updated_at before update on public.bug_reports
  for each row execute function public.set_updated_at();

alter table public.bug_reports enable row level security;

create policy "Authenticated users can read all bug reports"
  on public.bug_reports for select to authenticated using (true);

create policy "Authenticated users can insert bug reports"
  on public.bug_reports for insert to authenticated with check (true);

create policy "Authenticated users can update bug reports"
  on public.bug_reports for update to authenticated using (true) with check (true);
