-- Promotional Content Hub schema (idempotent)

-- ROLES: what a user can DO (actions). Fixed set.
CREATE TABLE IF NOT EXISTS roles (
  name        TEXT PRIMARY KEY,
  description TEXT,
  rank        INT NOT NULL DEFAULT 0
);

INSERT INTO roles (name, description, rank) VALUES
  ('Admin',   'Full access to every page; manages users, groups, dropdowns, branding, audit', 4),
  ('Manager', 'Create/edit/send ingest, approve/reject, edit workload (on pages their group can open)', 3),
  ('Editor',  'Create/edit/send ingest (on pages their group can open)', 2),
  ('Viewer',  'Read-only on pages their group can open', 1)
ON CONFLICT (name) DO NOTHING;

-- GROUPS: where a user is enrolled. Admin-defined. Decide which pages/sections members can open.
CREATE TABLE IF NOT EXISTS groups (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS groups_name_lower_uq ON groups (lower(name));

-- Page / section keys granted to a group (keys defined in src/permissions.js CATALOG)
CREATE TABLE IF NOT EXISTS group_permissions (
  group_id    INT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  perm_key    TEXT NOT NULL,
  PRIMARY KEY (group_id, perm_key)
);

CREATE TABLE IF NOT EXISTS users (
  id                   SERIAL PRIMARY KEY,
  username             TEXT NOT NULL,
  full_name            TEXT NOT NULL,
  email                TEXT,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL REFERENCES roles(name) ON UPDATE CASCADE,
  group_id             INT REFERENCES groups(id) ON DELETE RESTRICT,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  totp_secret          TEXT,
  totp_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts      INT NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- upgrade paths for older databases
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;
-- per-user appearance: system | dark | light
ALTER TABLE users ADD COLUMN IF NOT EXISTS appearance TEXT NOT NULL DEFAULT 'system' CHECK (appearance IN ('system','dark','light'));  -- last TOTP time-step used (replay protection)
ALTER TABLE users ADD COLUMN IF NOT EXISTS group_id INT REFERENCES groups(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS users_group_idx ON users (group_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uq ON users (lower(username));

-- Session store (connect-pg-simple). Created here so the app's runtime DB role needs no DDL rights.
CREATE TABLE IF NOT EXISTS user_sessions (
  sid    VARCHAR NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions (expire);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  username    TEXT,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  details     JSONB,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action);

CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, is_read, created_at DESC);

CREATE TABLE IF NOT EXISTS dropdown_options (
  id          SERIAL PRIMARY KEY,
  category    TEXT NOT NULL,
  value       TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category, value)
);

CREATE TABLE IF NOT EXISTS ingest_records (
  id                    SERIAL PRIMARY KEY,
  program               TEXT NOT NULL,
  platform              TEXT NOT NULL,
  episode_date          DATE,
  source                TEXT,
  destination_folder    TEXT,
  requested_by_user_id  INT REFERENCES users(id) ON DELETE SET NULL,
  requested_by_psd      TEXT,
  remarks               TEXT,
  status                TEXT NOT NULL DEFAULT 'New'
                        CHECK (status IN ('New','Pending Approval','Approved','Rejected')),
  created_by            INT REFERENCES users(id) ON DELETE SET NULL,
  updated_by            INT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingest_status_idx ON ingest_records (status);
CREATE INDEX IF NOT EXISTS ingest_created_idx ON ingest_records (created_at DESC);

CREATE TABLE IF NOT EXISTS approval_requests (
  id                SERIAL PRIMARY KEY,
  ingest_record_id  INT NOT NULL REFERENCES ingest_records(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'Pending'
                    CHECK (status IN ('Pending','Approved','Rejected')),
  requested_by      INT REFERENCES users(id) ON DELETE SET NULL,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by        INT REFERENCES users(id) ON DELETE SET NULL,
  decided_at        TIMESTAMPTZ,
  decision_note     TEXT
);
CREATE INDEX IF NOT EXISTS approval_status_idx ON approval_requests (status, requested_at DESC);
-- only one open request per ingest record
CREATE UNIQUE INDEX IF NOT EXISTS approval_one_pending_uq
  ON approval_requests (ingest_record_id) WHERE status = 'Pending';

-- Workload Tracker: ONE table for all sections (VEDIT / VGFX / AUDIO).
-- Shared columns apply to every row; video columns are used by VEDIT/VGFX only and
-- length/status by AUDIO only. The API blanks columns that do not belong to the row's section.
CREATE TABLE IF NOT EXISTS workload_items (
  id          SERIAL PRIMARY KEY,
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  updated_by  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- ADD COLUMN IF NOT EXISTS so installs that already have the placeholder table are upgraded in place
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS work_date   DATE;
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS section     TEXT CHECK (section IN ('VEDIT','VGFX','AUDIO'));
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS platform    TEXT;
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS plug_id     TEXT;
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS psd         TEXT;
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS prog_name   TEXT;
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS remarks     TEXT;
-- VEDIT / VGFX only
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS breakdate   TEXT;
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS vo          TEXT;
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS script      TEXT;
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS art_stb     TEXT;
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS audio_guide TEXT;
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS total_mats  TEXT;
-- AUDIO only
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS length      TEXT;
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS status      TEXT;
CREATE INDEX IF NOT EXISTS workload_items_date_section_idx ON workload_items (work_date DESC, section);

CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_settings (key, value) VALUES
  ('app_name', 'Promotional Content Hub'),
  ('tagline',  'Ingest · Approval · Workload'),
  ('theme', 'midnight'),
  ('accent_color', ''),
  ('logo_path', '')
ON CONFLICT (key) DO NOTHING;

-- Starter dropdown values (only inserted if the category is empty)
INSERT INTO dropdown_options (category, value, sort_order)
SELECT 'platform', v, o FROM (VALUES
  ('TV',1),('YouTube',2),('Facebook',3),('TikTok',4),('Instagram',5),('Website',6),('X',7)
) AS t(v,o)
WHERE NOT EXISTS (SELECT 1 FROM dropdown_options WHERE category = 'platform');

-- Workload platform choices (from the PCS Workload template's filter pool); only inserted if the category is empty
INSERT INTO dropdown_options (category, value, sort_order)
SELECT 'workload_platform', v, o FROM (VALUES
  ('GMA',1),('GTV',2),('HOA',3),('IHM',4),('DIGITAL',5),('GPTV',6),('GNTV',7),('GLTV',8),
  ('INTL DIGITAL',9),('INTL MKTG',10),
  ('REG/TDMD (SYNERGY)',11),('REG/TDMD (SPARKLE)',12),('REG/TDMD (GMA MUSIC)',13),('REG/TDMD (GMA PICTURES)',14),
  ('REG/TDMD (RGMA)',15),('REG/TDMD (RTV LOCAL AIRING)',16),('REG/TDMD (PG_REGIONAL AIRING)',17),
  ('ALL 6 CHANNELS',18),('AFFORDABOX',19),('CORPORATE',20),('GMAI',21),('GMAIN',22),('GMA NOW',23),
  ('HALLYPOP',24),('PINOY HITS',25),('PSD-DIGITAL',26),('RADIO',27)
) AS t(v,o)
WHERE NOT EXISTS (SELECT 1 FROM dropdown_options WHERE category = 'workload_platform');

-- Themes: older installs stored the Midnight accent as an explicit override; clear it so the theme's own accent applies
INSERT INTO app_settings (key, value) VALUES ('theme', 'midnight') ON CONFLICT (key) DO NOTHING;
UPDATE app_settings SET value = '' WHERE key = 'accent_color' AND lower(value) = '#4f8cff';
