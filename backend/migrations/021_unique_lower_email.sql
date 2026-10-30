-- Emails are compared case-insensitively by the API. Enforce that in the DB
-- too, but never fail startup on legacy data: if case-variant duplicates
-- already exist, skip and leave a notice for the operator to clean up.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users GROUP BY LOWER(email) HAVING COUNT(*) > 1) THEN
    RAISE NOTICE 'Skipping users_email_lower_key: case-variant duplicate emails exist; merge them, then create the index manually: CREATE UNIQUE INDEX users_email_lower_key ON users (LOWER(email)); (this migration will not run again).';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (LOWER(email));
  END IF;
END $$;
