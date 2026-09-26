-- Least-privilege runtime login for Promotional Content Hub.
--
-- 1. Run migrations with the OWNER login (creates/changes tables):
--      DATABASE_URL=postgres://promohub_owner:...@host/promohub npm run migrate
-- 2. Create the runtime login and grants (run as owner/superuser, set your own password):
--      psql -d promohub -v app_pw="'CHANGE_ME'" -f db/app-role.sql
-- 3. Run the app with the runtime login and no startup migrations:
--      DATABASE_URL=postgres://promohub_app:...@host/promohub  MIGRATE_ON_START=false
-- Re-run step 2 after each migration that adds tables.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'promohub_app') THEN
    CREATE ROLE promohub_app LOGIN;
  END IF;
END $$;
ALTER ROLE promohub_app PASSWORD :app_pw;

REVOKE CREATE ON SCHEMA public FROM promohub_app;
GRANT USAGE ON SCHEMA public TO promohub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO promohub_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO promohub_app;
-- roles are fixed reference data
REVOKE INSERT, UPDATE, DELETE ON roles FROM promohub_app;
-- audit log is append-only for the app
REVOKE UPDATE, DELETE ON audit_logs FROM promohub_app;
