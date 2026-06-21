-- 034 — Fix user_events RLS performance
--
-- The original policy uses public.auth_role() which calls
-- SELECT role FROM profiles WHERE id = auth.uid() once per ROW.
-- With 23k+ rows this exceeds statement_timeout.
--
-- Fix: replace per-row function call with EXISTS subquery that
-- PostgreSQL folds into a one-time InitPlan.
-- Also add a standalone created_at index for the common range scan.

-- 1) Replace slow SELECT policy
drop policy if exists "user_events_admin_read" on public.user_events;
create policy "user_events_admin_read" on public.user_events for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- 2) Replace slow DELETE policy (same pattern)
drop policy if exists "user_events_admin_delete" on public.user_events;
create policy "user_events_admin_delete" on public.user_events for delete
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- 3) Add standalone created_at index for range queries
create index if not exists user_events_created_at_idx
  on public.user_events (created_at desc);
