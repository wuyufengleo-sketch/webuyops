-- 031 — Add missing INSERT/UPDATE RLS policies on manifest_passengers
--
-- manifest_passengers only had a SELECT policy (read_all_authenticated).
-- All per-pax edits (visa_status, document fields, etc.) via the Visa Detail
-- page silently failed: PostgREST returned 200 with data:[] instead of an
-- error, so the UI flashed "saved" but the value reverted on next render.

CREATE POLICY "Authenticated users can insert manifest_passengers"
  ON public.manifest_passengers FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update manifest_passengers"
  ON public.manifest_passengers FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
