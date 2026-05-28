-- ============================================================================
--  Fix seeded users — fill in fields that newer Supabase Auth requires.
--  Run once in SQL Editor.
-- ============================================================================

UPDATE auth.users
SET
  is_anonymous              = COALESCE(is_anonymous, false),
  is_sso_user               = COALESCE(is_sso_user, false),
  is_super_admin            = COALESCE(is_super_admin, false),
  confirmation_token        = COALESCE(confirmation_token, ''),
  recovery_token            = COALESCE(recovery_token, ''),
  email_change_token_new    = COALESCE(email_change_token_new, ''),
  email_change_token_current= COALESCE(email_change_token_current, ''),
  email_change              = COALESCE(email_change, ''),
  phone_change              = COALESCE(phone_change, ''),
  phone_change_token        = COALESCE(phone_change_token, ''),
  reauthentication_token    = COALESCE(reauthentication_token, ''),
  email_change_confirm_status = COALESCE(email_change_confirm_status, 0)
WHERE email LIKE '%@webuy.local';

-- Show the users so we can confirm
SELECT
  email,
  email_confirmed_at IS NOT NULL  AS email_confirmed,
  encrypted_password IS NOT NULL  AS has_password,
  is_anonymous,
  is_sso_user,
  aud,
  role
FROM auth.users
WHERE email LIKE '%@webuy.local'
ORDER BY email;
