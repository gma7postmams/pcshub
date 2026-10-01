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
  billable_party        TEXT,
  platform              TEXT NOT NULL,
  episode_date          DATE,
  episode_break_date_text TEXT,
  materials_count       INTEGER,
  source                TEXT,
  destination_folder    TEXT,
  requested_by_user_id  INT REFERENCES users(id) ON DELETE SET NULL,
  requested_by_psd      TEXT,
  remarks               TEXT,
  status                TEXT NOT NULL DEFAULT 'New'
                        CHECK (status IN ('New','Pending Approval','Approved','Rejected')),
  cm_status             TEXT CHECK (cm_status IN ('DONE','NON-COMPLIANT')),
  cm_decided_by         INT REFERENCES users(id) ON DELETE SET NULL,
  cm_decided_at         TIMESTAMPTZ,
  cm_non_compliant_reason TEXT,
  created_by            INT REFERENCES users(id) ON DELETE SET NULL,
  updated_by            INT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ingest_cm_decision_consistent CHECK (
    (cm_status IS NULL AND cm_decided_by IS NULL AND cm_decided_at IS NULL AND cm_non_compliant_reason IS NULL)
    OR (cm_status = 'DONE' AND status = 'Approved' AND cm_decided_at IS NOT NULL AND cm_non_compliant_reason IS NULL)
    OR (cm_status = 'NON-COMPLIANT' AND status = 'Approved' AND cm_decided_at IS NOT NULL
        AND cm_non_compliant_reason IS NOT NULL AND length(btrim(cm_non_compliant_reason)) > 0)
  )
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

-- Workload Tracker: ONE table for every team. "Units Concerned" says which team(s) a plug is for
-- (VGFX / VEDIT / Audio, alone or combined). Columns follow the Sept 2026 PCS Workload template.
CREATE TABLE IF NOT EXISTS workload_items (
  id          SERIAL PRIMARY KEY,
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  updated_by  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upgrade from the first Workload build (Section Assigned + free-text columns) to the Sept 2026 template.
-- Idempotent: each step only runs while the old shape is still there.
DO $$
BEGIN
  -- Section Assigned (VEDIT / VGFX / AUDIO) -> Units Concerned
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
              AND table_name = 'workload_items' AND column_name = 'section') THEN
    ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS units_concerned TEXT;
    UPDATE workload_items SET units_concerned = CASE section
        WHEN 'VEDIT' THEN 'VEDIT Only' WHEN 'VGFX' THEN 'VGFX Only' WHEN 'AUDIO' THEN 'Audio - RADIO' END
      WHERE units_concerned IS NULL;
    ALTER TABLE workload_items DROP COLUMN section;
  END IF;
  -- Breakdate (free text) becomes Breakdate (date) + Time (open text): keep the old text as the time
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
              AND table_name = 'workload_items' AND column_name = 'breakdate' AND data_type = 'text')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
              AND table_name = 'workload_items' AND column_name = 'breakdate_time') THEN
    ALTER TABLE workload_items RENAME COLUMN breakdate TO breakdate_time;
  END IF;
  -- Script and Artwork/STB become real dates (only values that are already ISO dates are kept)
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
              AND table_name = 'workload_items' AND column_name = 'script' AND data_type = 'text') THEN
    ALTER TABLE workload_items ALTER COLUMN script TYPE DATE
      USING (CASE WHEN script ~ '^\d{4}-\d{2}-\d{2}$' THEN script::date END);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
              AND table_name = 'workload_items' AND column_name = 'art_stb' AND data_type = 'text') THEN
    ALTER TABLE workload_items ALTER COLUMN art_stb TYPE DATE
      USING (CASE WHEN art_stb ~ '^\d{4}-\d{2}-\d{2}$' THEN art_stb::date END);
  END IF;
END $$;

ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS work_date       DATE;
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS platform        TEXT;   -- dropdown; auto-filled from the Plug ID prefix
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS billable_party  TEXT;   -- open
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS units_concerned TEXT;   -- dropdown (6 fixed options, see constraint below)
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS plug_id         TEXT;   -- copied from the PSD daily plug list
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS psd             TEXT;   -- copied from the PSD daily plug list
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS breakdate       TIMESTAMP;   -- Breakdate/Time: date and time picked together (wall-clock, no time zone)
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS vo              TEXT;   -- open
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS script          DATE;   -- date
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS art_stb         DATE;   -- date
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS audio_guide     TEXT;   -- dropdown: 'N/A' or a date (YYYY-MM-DD)
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS remarks         TEXT;   -- open
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS total_mats      TEXT;   -- open
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS prog_name       TEXT;   -- copied from the PSD daily plug list
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS plug_type       TEXT;   -- dropdown (admin-managed)
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS length          TEXT;   -- Audio: open (older installs already have this column)
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS others          TEXT;   -- Audio: open
-- (Older installs may still have an unused status column from the first build; it is left untouched.)

-- Breakdate and Time used to be two fields (a date, and a time that was free text and then a picked HH:MM). They are now one
-- Breakdate/Time value. Runs only while the old breakdate_time column still exists:
--  * typed text in it -> the first clock time in it (e.g. 10am -> 10:00) is used, the original text is added to Remarks
--  * breakdate (date) + that time -> one timestamp (a date without a time becomes 12:00 AM and shows as date only)
--  * a time with no date has nowhere to go, so it is added to Remarks
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
              AND table_name = 'workload_items' AND column_name = 'breakdate_time') THEN
    UPDATE workload_items SET
      remarks = concat_ws(E'\n', remarks, 'Time (as typed before): ' || breakdate_time),
      breakdate_time = (
        SELECT CASE WHEN m IS NOT NULL AND m[1]::int BETWEEN 1 AND 12 AND COALESCE(m[2], '0')::int <= 59
          THEN to_char(make_time(CASE WHEN lower(m[3]) = 'pm' THEN (m[1]::int % 12) + 12 ELSE m[1]::int % 12 END, COALESCE(m[2], '0')::int, 0), 'HH24:MI')
          END
        FROM (SELECT regexp_match(breakdate_time, '(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])') AS m) x)
    WHERE breakdate_time IS NOT NULL AND breakdate_time !~ '^([01]\d|2[0-3]):[0-5]\d$';
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                AND table_name = 'workload_items' AND column_name = 'breakdate' AND data_type = 'date') THEN
      ALTER TABLE workload_items ALTER COLUMN breakdate TYPE TIMESTAMP
        USING (breakdate::timestamp + COALESCE(breakdate_time::time, TIME '00:00'));
    END IF;
    UPDATE workload_items SET remarks = concat_ws(E'\n', remarks, 'Breakdate time: ' || breakdate_time)
      WHERE breakdate IS NULL AND breakdate_time IS NOT NULL;
    ALTER TABLE workload_items DROP COLUMN breakdate_time;
  END IF;
END $$;

-- Breakdate/Time is now two separate times (VGFX's and VEDIT's) plus a short note, matching the template's
-- practice of listing both when a plug needs both teams. Runs only while the old single 'breakdate' column
-- still exists. There is no historical record of which team a single old value belonged to, so it is assigned
-- by this row's Units Concerned: VGFX's slot when VGFX is involved, otherwise VEDIT's slot.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
              AND table_name = 'workload_items' AND column_name = 'breakdate') THEN
    ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS breakdate_vgfx TIMESTAMP;
    ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS breakdate_vedit TIMESTAMP;
    UPDATE workload_items SET breakdate_vgfx = breakdate
      WHERE breakdate IS NOT NULL AND units_concerned IN ('VGFX Only', 'VGFX/VEDIT', 'VGFX/VEDIT/Audio');
    UPDATE workload_items SET breakdate_vedit = breakdate
      WHERE breakdate IS NOT NULL AND units_concerned = 'VEDIT Only';
    ALTER TABLE workload_items DROP COLUMN breakdate;
  END IF;
END $$;
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS breakdate_vgfx  TIMESTAMP;   -- Breakdate/Time (VGFX)
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS breakdate_vedit TIMESTAMP;   -- Breakdate/Time (VEDIT)
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS breakdate_note  TEXT;        -- open: short note attached to the time(s)

-- A workflow "Status" column was tried in a draft of the redesign and removed again; drop it if a database got it.
ALTER TABLE workload_items DROP COLUMN IF EXISTS work_status;
ALTER TABLE workload_items DROP CONSTRAINT IF EXISTS workload_items_units_check;
ALTER TABLE workload_items ADD CONSTRAINT workload_items_units_check CHECK (units_concerned IN
  ('VGFX Only', 'VEDIT Only', 'VGFX/VEDIT', 'Audio - RADIO', 'Audio – AUDIO GUIDE', 'VGFX/VEDIT/Audio'));
CREATE INDEX IF NOT EXISTS workload_items_date_units_idx ON workload_items (work_date DESC, units_concerned);

CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Knowledge Base: PDF reference documents (files live on disk under uploads/knowledge/)
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  filename      TEXT NOT NULL,            -- original file name, used for downloads
  stored_name   TEXT NOT NULL UNIQUE,     -- random name on disk
  size_bytes    BIGINT NOT NULL,
  sha256        TEXT NOT NULL,
  uploaded_by   INT REFERENCES users(id) ON DELETE SET NULL,
  uploaded_name TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_docs_created_idx ON knowledge_docs (created_at DESC);

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

-- Workload Platform choices: the values the template's Platform formula produces, plus the older list.
-- Added once (flag in app_settings) so options an Admin later deletes are not brought back on restart.
INSERT INTO dropdown_options (category, value, sort_order)
SELECT 'workload_platform', v, o FROM (VALUES
  ('GMA',1),('GTV',2),('HOA',3),('IHM',4),('DIGITAL',5),('GPTV',6),('GNTV',7),('GLTV',8),
  ('INTL DIGITAL',9),('INTL MKTG',10),
  ('REG/TDMD (SYNERGY)',11),('REG/TDMD (SPARKLE)',12),('REG/TDMD (GMA MUSIC)',13),('REG/TDMD (GMA PICTURES)',14),
  ('REG/TDMD (RGMA)',15),('REG/TDMD (RTV LOCAL AIRING)',16),('REG/TDMD (PG_REGIONAL AIRING)',17),
  ('REG/TDMD (PSD-DIGITAL)',18),
  ('ALL 6 CHANNELS',19),('AFFORDABOX',20),('CORPORATE',21),('GMAI',22),('GMAIN',23),('GMA NOW',24),
  ('HALLYPOP',25),('PINOY HITS',26),('PSD-DIGITAL',27),('RADIO',28)
) AS t(v,o)
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'seed_workload_platform_v2')
ON CONFLICT (category, value) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('seed_workload_platform_v2', '1') ON CONFLICT (key) DO NOTHING;

-- Plug Type choices (values seen in the Sept 2026 template); only inserted if the category is empty
INSERT INTO dropdown_options (category, value, sort_order)
SELECT 'plug_type', v, o FROM (VALUES
  ('EPISODIC',1),('SEASONAL',2),('BUMPER',3),('POP-UP/POP LOGO',4),('RADIO',5)
) AS t(v,o)
WHERE NOT EXISTS (SELECT 1 FROM dropdown_options WHERE category = 'plug_type');

-- Themes: older installs stored the Midnight accent as an explicit override; clear it so the theme's own accent applies
INSERT INTO app_settings (key, value) VALUES ('theme', 'midnight') ON CONFLICT (key) DO NOTHING;
UPDATE app_settings SET value = '' WHERE key = 'accent_color' AND lower(value) = '#4f8cff';

-- Custom Workload columns: admins can add extra columns beyond the template's fixed fields. Values live in
-- workload_items.custom_fields as {col_key: text}, so adding/removing a column never requires an ALTER TABLE
-- or a migration; col_key is 'custom_<id>' (not the label) so renaming/duplicate labels are never a problem.
CREATE TABLE IF NOT EXISTS workload_custom_columns (
  id          SERIAL PRIMARY KEY,
  col_key     TEXT UNIQUE,   -- set to 'custom_'||id right after insert
  label       TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Workload date locks: an Admin can freeze a date range (e.g. a closed month) so its rows can't be edited,
-- deleted, or have new rows created in it. Admins themselves can still override — this is a period lock,
-- not a hard permission wall.
CREATE TABLE IF NOT EXISTS workload_locks (
  id          SERIAL PRIMARY KEY,
  from_date   DATE NOT NULL,
  to_date     DATE NOT NULL,
  note        TEXT,
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date)
);

-- Workload priority flag: a prioritised row gets its Breakdate/Time cell highlighted in the UI.
ALTER TABLE workload_items ADD COLUMN IF NOT EXISTS is_priority BOOLEAN NOT NULL DEFAULT false;
