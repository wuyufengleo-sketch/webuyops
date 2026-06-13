-- 029 — Add total_price / single_entry_visa enrichment columns to package_sales
--
-- Commits db517c6 (TOTAL PRICE per tour_code) and the SINGLE ENTRY VISA add-on
-- made sync-skybar / _sheet-prices harvest two fields that have no column in
-- package_sales (migration 006 only defined basic_price, visa_price,
-- dbl_entry_visa, … single_entry_visa and total_price were never added).
--
-- Upserting an unknown column makes PostgREST reject the whole batch (PGRST204),
-- which took down the entire daily sync whenever the Google Sheet loaded. The
-- code now probes for these columns and strips them when absent (sync-skybar.js),
-- but the proper fix is to add the columns so the data persists for price-watch
-- and any other consumer.
--
--   • total_price        — Product's pre-computed standard sell price
--                          (basic + visa + tipping + insurance + opt mandatory),
--                          used as the price-watch comparison baseline.
--   • single_entry_visa  — single-entry visa add-on (vs the existing
--                          dbl_entry_visa column).

alter table public.package_sales
  add column if not exists total_price       numeric(18,2),
  add column if not exists single_entry_visa numeric(18,2);
