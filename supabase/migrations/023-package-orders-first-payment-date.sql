-- Store the first actual received payment date from Skybear
-- wt_order_payment_receipt. CS balance collection rules use this to detect
-- 1jt lock bookings whose full deposit is not completed within 7 days.
alter table public.package_orders
  add column if not exists order_first_payment_date date;

create index if not exists package_orders_first_payment_date_idx
  on public.package_orders(order_first_payment_date);
