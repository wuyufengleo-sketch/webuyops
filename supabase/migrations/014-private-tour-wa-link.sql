-- ============================================================================
--  Sprint 10 — Private Tour WhatsApp group link
--
--  Each private-tour record can store one WA group invite URL
--  (https://chat.whatsapp.com/...). One-click "💬 WA" button in the table
--  opens it in WhatsApp Web or the mobile app — gets sales / OPS / customer
--  into the same conversation without manual scrolling through chats.
--
--  Run in the Supabase SQL Editor before deploying.
-- ============================================================================

alter table public.private_tours
  add column if not exists "waLink" text;
