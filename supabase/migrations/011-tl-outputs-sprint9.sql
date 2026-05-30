-- ============================================================================
--  Sprint 9 (slice 2) — TL Output checklist
--
--  One row per BK tour holding the tour leader's 5-area post-tour deliverables:
--    📸 photos · 📝 daily report · ⭐ customer feedback · 🚨 incident · 💰 finance
--  Each area: a status text (DONE/PENDING/N/A) + free-text + (where useful) a
--  link or numeric. Feeds the CS Module "TL Output" tab and supplies signal to
--  the "TL Performance" tab (output completion rate per TL).
--
--  Run in the Supabase SQL Editor before deploying the slice 2 app.html.
-- ============================================================================

create table if not exists public.tl_outputs (
  id text primary key,              -- = tour_id (1:1 with bk_tours)
  tour_id text,                     -- denormalized for legibility / future FK
  tl_name text,                     -- snapshot of bk_tours.tl at creation time
  photos_status text,               -- DONE / PENDING / N/A
  photos_link text,                 -- drive link or note
  report_status text,
  report_text text,                 -- daily report / 行程总结
  feedback_status text,
  feedback_rating int,              -- 1..5
  feedback_text text,
  incident_status text,
  incident_text text,               -- short description; link to cs_complaints if any
  finance_status text,
  finance_amount numeric(18,2),     -- settled / reimbursement amount
  finance_text text,
  notes text,
  created_by uuid references auth.users(id), created_at timestamptz default now(),
  updated_by uuid references auth.users(id), updated_at timestamptz default now()
);

create index if not exists tl_outputs_tl_idx on public.tl_outputs (tl_name);

do $$ begin
  drop trigger if exists tl_outputs_updated_at on public.tl_outputs;
  create trigger tl_outputs_updated_at before update on public.tl_outputs
    for each row execute function public.set_updated_at();
end $$;

alter table public.tl_outputs enable row level security;
drop policy if exists "auth read"  on public.tl_outputs;
drop policy if exists "auth write" on public.tl_outputs;
create policy "auth read"  on public.tl_outputs for select using (auth.role()='authenticated');
create policy "auth write" on public.tl_outputs for all    using (auth.role()='authenticated') with check (auth.role()='authenticated');

do $$ begin alter publication supabase_realtime add table public.tl_outputs;
exception when duplicate_object then null; end $$;
