-- 033 — OPS outcome ledger + Leo-only daily report
--
-- Purpose:
--   Track business outcomes, not just clicks. user_events remains the raw
--   behavior evidence; ops_outcomes records what each staff member actually
--   completed and what changed.

create table if not exists public.ops_tasks (
  id              text primary key,
  task_type       text not null,
  severity        text not null default 'normal' check (severity in ('low','normal','high','critical')),
  title           text not null,
  object_type     text,
  object_id       text,
  object_label    text,
  assigned_to     uuid references auth.users(id),
  assigned_name   text,
  status          text not null default 'open' check (status in ('open','in_progress','done','snoozed','escalated','cancelled')),
  due_at          timestamptz,
  source          text default 'system',
  payload         jsonb not null default '{}'::jsonb,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create index if not exists ops_tasks_status_due_idx on public.ops_tasks(status, due_at);
create index if not exists ops_tasks_assignee_idx on public.ops_tasks(assigned_to, created_at desc);
create index if not exists ops_tasks_type_idx on public.ops_tasks(task_type, created_at desc);

drop trigger if exists ops_tasks_updated_at on public.ops_tasks;
create trigger ops_tasks_updated_at before update on public.ops_tasks
  for each row execute function public.set_updated_at();

create table if not exists public.ops_outcomes (
  id                  bigint generated always as identity primary key,
  user_id              uuid references auth.users(id),
  username             text,
  role                 text,
  department           text,
  outcome_date         date not null default current_date,
  outcome_type         text not null,
  object_type          text,
  object_id            text,
  object_label         text,
  task_id              text references public.ops_tasks(id) on delete set null,
  before_state         text,
  after_state          text,
  completed_what       text not null,
  achieved_what        text,
  business_impact      jsonb not null default '{}'::jsonb,
  evidence             jsonb not null default '{}'::jsonb,
  quality_score        numeric,
  fake_use_risk        text default 'unknown' check (fake_use_risk in ('low','medium','high','unknown')),
  created_at           timestamptz not null default now()
);

create index if not exists ops_outcomes_user_date_idx on public.ops_outcomes(user_id, outcome_date desc);
create index if not exists ops_outcomes_date_type_idx on public.ops_outcomes(outcome_date desc, outcome_type);
create index if not exists ops_outcomes_task_idx on public.ops_outcomes(task_id);

create table if not exists public.leo_daily_reports (
  report_date      date primary key,
  owner_user_id    uuid references auth.users(id),
  summary          jsonb not null default '{}'::jsonb,
  generated_at     timestamptz not null default now(),
  generated_by     uuid references auth.users(id)
);

alter table public.ops_tasks enable row level security;
alter table public.ops_outcomes enable row level security;
alter table public.leo_daily_reports enable row level security;

drop policy if exists ops_tasks_read_authenticated on public.ops_tasks;
create policy ops_tasks_read_authenticated on public.ops_tasks
  for select to authenticated using (true);

drop policy if exists ops_tasks_insert_own_or_admin on public.ops_tasks;
create policy ops_tasks_insert_own_or_admin on public.ops_tasks
  for insert to authenticated
  with check (
    public.auth_role() = 'admin'
    or assigned_to = (select auth.uid())
    or created_by = (select auth.uid())
  );

drop policy if exists ops_tasks_update_own_or_admin on public.ops_tasks;
create policy ops_tasks_update_own_or_admin on public.ops_tasks
  for update to authenticated
  using (
    public.auth_role() = 'admin'
    or assigned_to = (select auth.uid())
    or created_by = (select auth.uid())
  )
  with check (
    public.auth_role() = 'admin'
    or assigned_to = (select auth.uid())
    or created_by = (select auth.uid())
  );

drop policy if exists ops_tasks_delete_admin on public.ops_tasks;
create policy ops_tasks_delete_admin on public.ops_tasks
  for delete to authenticated using (public.auth_role() = 'admin');

drop policy if exists ops_outcomes_self_or_admin_read on public.ops_outcomes;
create policy ops_outcomes_self_or_admin_read on public.ops_outcomes
  for select to authenticated
  using (user_id = (select auth.uid()) or public.auth_role() = 'admin');

drop policy if exists ops_outcomes_self_insert on public.ops_outcomes;
create policy ops_outcomes_self_insert on public.ops_outcomes
  for insert to authenticated
  with check (user_id = (select auth.uid()) or public.auth_role() = 'admin');

drop policy if exists leo_daily_reports_owner_read on public.leo_daily_reports;
create policy leo_daily_reports_owner_read on public.leo_daily_reports
  for select to authenticated
  using (owner_user_id = (select auth.uid()));

drop policy if exists leo_daily_reports_owner_write on public.leo_daily_reports;
create policy leo_daily_reports_owner_write on public.leo_daily_reports
  for all to authenticated
  using (owner_user_id = (select auth.uid()))
  with check (owner_user_id = (select auth.uid()));

create or replace view public.ops_outcomes_daily
with (security_invoker = true) as
select
  outcome_date,
  coalesce(username, user_id::text, 'unknown') as username,
  coalesce(role, 'unknown') as role,
  count(*) as outcomes,
  count(*) filter (where coalesce(achieved_what,'') <> '') as achieved_count,
  count(*) filter (where fake_use_risk = 'high') as high_fake_use_risk,
  jsonb_agg(
    jsonb_build_object(
      'type', outcome_type,
      'object', object_label,
      'completed', completed_what,
      'achieved', achieved_what,
      'impact', business_impact,
      'at', created_at
    )
    order by created_at desc
  ) as outcome_items
from public.ops_outcomes
group by 1,2,3;

grant select, insert, update, delete on public.ops_tasks to authenticated;
grant select, insert on public.ops_outcomes to authenticated;
grant select, insert, update, delete on public.leo_daily_reports to authenticated;
grant usage, select on sequence public.ops_outcomes_id_seq to authenticated;
grant select on public.ops_outcomes_daily to authenticated;
