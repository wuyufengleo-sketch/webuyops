-- 027 — Add four operational cost categories to per-tour PnL
--
-- The original PnL (migration 024) only had land_cost / flight_cost /
-- other_cost as manual entry fields. OPS routinely tracks these four
-- as discrete line items, and lumping them into "other_cost" hides
-- them from the per-tour margin view:
--
--   • visa_cost              — group visa fees paid to the agent
--   • tl_cost                — tour leader (TL) honorarium / per-diem
--   • airport_handling_cost  — porter, fast-track, lounge passes etc.
--   • tipping_cost           — driver / guide / TL tipping pool
--
-- Each has an optional note for the vendor / breakdown the OPS person
-- wants to remember. Default NULL so existing rows stay valid; the
-- gross-margin formula in the front-end now subtracts all four on top
-- of land + flight + other.

alter table public.tour_pnl
  add column if not exists visa_cost                numeric,
  add column if not exists visa_cost_note           text,
  add column if not exists tl_cost                  numeric,
  add column if not exists tl_cost_note             text,
  add column if not exists airport_handling_cost    numeric,
  add column if not exists airport_handling_note    text,
  add column if not exists tipping_cost             numeric,
  add column if not exists tipping_cost_note        text;
