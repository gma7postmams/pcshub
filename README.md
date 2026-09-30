# Promotional Content Hub

Multi-user tracker for promotional content: **Ingest Tracker → Approval**, **Workload Tracker**, Reports, Knowledge Base, Dashboard, Admin.
Node.js (Express) + PostgreSQL API · **React 18 + Vite** front end · themes with dark/light · top navigation only · mobile-ready PWA · no AI.

## Quick start

```bash
cp .env.example .env          # set DATABASE_URL, SESSION_SECRET, ADMIN_USERNAME / ADMIN_PASSWORD
npm install
npm run build                 # builds the React front end into client/dist
npm start                     # creates tables + seeds the Admin on first boot
```

### Front-end development

```bash
npm start                     # API on :3000
npm run dev:client            # Vite on :5173 with hot reload, proxies /api to :3000
```
Edit React code in `client/src/`, then `npm run build` before deploying. The server refuses to start if `client/dist` is missing.

Open `http://localhost:3000`, sign in with the seeded Admin, set a new password (forced on first login), then:

1. **Admin → Dropdowns**: add PROGRAM values (Platform has starter values).
2. **Admin → Groups**: create groups and tick the pages/sections each can open.
3. **Admin → Users**: create users, set their role, enroll them in a group.

### Production (native, systemd)

Requirements: Node.js 18+ (22 LTS recommended), PostgreSQL 14+, nginx.

```bash
# 1. App user + code
sudo useradd --system --home /opt/promo-hub --shell /usr/sbin/nologin promohub
sudo cp -r promo-hub /opt/promo-hub
cd /opt/promo-hub && sudo -u promohub npm ci --omit=dev && sudo -u promohub npm run build

# 2. Config
sudo -u promohub cp .env.example .env      # fill SESSION_SECRET, TOTP_ENC_KEY, DATABASE_URL, ADMIN_PASSWORD
sudo chmod 600 .env

# 3. Database (owner login runs migrations; app runs as least-privilege login)
sudo -u promohub npm run migrate           # with the owner DATABASE_URL
sudo -u postgres psql -d promohub -v app_pw="'STRONG_PASSWORD'" -f db/app-role.sql
#    then set DATABASE_URL to promohub_app and MIGRATE_ON_START=false in .env

# 4. Service
sudo cp deploy/promo-hub.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now promo-hub
journalctl -u promo-hub -f                 # logs

# 5. HTTPS reverse proxy
sudo cp deploy/nginx.conf /etc/nginx/sites-available/promo-hub   # edit server_name + cert paths
```

Upgrading: replace the code, `npm ci --omit=dev`, `npm run build`, `npm run migrate` (owner login), `sudo systemctl restart promo-hub`.
(You can also build on another machine and copy `client/dist/` to the server; the server itself only needs Node to run it.)

## Access model: roles vs groups

| | **Role** | **Group** |
|---|---|---|
| What it controls | What a user can **do** (actions) | Which pages / sections a user can **open** |
| Values | Fixed: Admin, Manager, Editor, Viewer | Admin-defined (Admin → Groups), any number |
| Per user | exactly one | one enrolment (or none) |

**Rules**
- **Admin role** opens every page and section and the Admin page; its group is ignored.
- Other roles open only what their group has checked. **No group means Profile only.** Users land on their first allowed page.
- An action needs **both** the role and the page: e.g. approving needs Manager role **and** a group with the Approval page.
- Profile is always available. The Admin page is Admin-role only and cannot be granted by a group.
- Changes to a user's role/group or a group's checkboxes apply on the user's next request. Locked pages are hidden from the nav and rejected by the server (403) on both the page and its API.

**Assignable pages and sections** (`CATALOG` in `src/permissions.js`)

| Page | Sections |
|------|----------|
| Dashboard | Ingest KPIs · Recent ingest activity |
| Ingest Tracker | — |
| Workload Tracker | — |
| Approval | — |
| Reports | Ingest & Approval summary · CSV export |
| Knowledge Base | — |

A section only takes effect if its page is also checked.

**Role actions** (`ROLE_ACTIONS`)

| Action | Needs page | Admin | Manager | Editor | Viewer |
|--------|-----------|:-----:|:-------:|:------:|:------:|
| Create / edit / send ingest | Ingest | ✓ | ✓ | ✓ | — |
| Delete ingest | Ingest | ✓ | — | — | — |
| Approve / reject | Approval | ✓ | ✓ | — | — |
| Edit Workload | Workload | ✓ | ✓ | — | — |
| Users, groups, dropdowns, branding, audit | Admin | ✓ | — | — | — |

Adding a new page or section: add it to `CATALOG`, then guard its route with `requirePageAccess(path)` or `requireSection(key)`. It then shows up as a checkbox in Admin → Groups automatically.

**Upgrading from the first version**: on startup the old `users.group_name` (which held Admin/Manager/Editor/Viewer) is migrated to `users.role`, and `groups` is recreated as enrolment groups. Existing non-Admin users start **Not enrolled** (Profile only) until you assign them a group.

## Themes & appearance

- **Theme (Admin → Branding, applies to everyone):** Midnight, Sunset, Purple, Ocean, Forest, Rose, Graphite. Each theme tints backgrounds and sets an accent tuned for readable contrast in both dark and light. Optional **custom accent** overrides the theme accent; button text colour is chosen automatically for contrast.
- **Appearance (per user):** Dark, Light or **System** (follows the device and switches live). Set in Profile → Appearance or the user menu; saved to the user's account (`users.appearance`).
- Implementation: `html[data-theme]` + `html[data-mode]` CSS variables in `client/src/app.css`; `client/public/theme-boot.js` applies the last-known theme in `<head>` so pages don't flash. Adding a theme = one CSS block + one entry in `src/themes.js` (and a swatch in `THEME_PREVIEW`, `client/src/lib/theme.js`).

## Workflow

**Ingest** — fields: PROGRAM, Platform (Admin-managed dropdowns), Episode date, Source, Destination Folder, Requested by (active users), Requested by (PSD), Remarks.
Status is the approval state and is never set by the client:

`New` → *Send for Approval* → `Pending Approval` → `Approved` / `Rejected`

- Records are editable only while `New` or `Rejected`. A rejected record can be edited and resubmitted (a new approval request is opened; full history is kept).
- Every approval request references an `ingest_record_id` (NOT NULL FK); only one pending request per record (partial unique index).
- Managers/Admins are notified on send; the sender, creator and "Requested by" user are notified on decision. Rejection requires a reason.

**Workload** — one table (`workload_items`) for every team, following the Sept 2026 PCS Workload template. **Units Concerned** (dropdown: VGFX Only, VEDIT Only, VGFX/VEDIT, Audio - RADIO, Audio – AUDIO GUIDE, VGFX/VEDIT/Audio) says which team(s) a plug is for; the page tabs (All / VGFX / VEDIT / Audio) show counts that follow the active filters and are filters over it themselves. Columns and field types come from the template's red notes: Platform (dropdown, auto-filled from the Plug ID prefix — same rules as the template's formula; PD_ plugs are set by hand to DIGITAL / INTL DIGITAL), Billable Party (open), Plug ID / PSD / Prog. Name (pasted from the PSD daily plug list), **Breakdate / Time** — one column/field in Table mode and the form, holding two underlying timestamps (VGFX's and VEDIT's) with no time zone; a row shows one pill when only one of those teams is involved, or two pills stacked one above the other (VGFX on top, VEDIT below; VGFX purple, VEDIT orange — the same colours as their pill in Units Concerned) when both are; each pill is its own click target, editing just that team's time. The form mirrors this: only the field(s) for a row's actual team(s) are shown, with the "(VGFX)"/"(VEDIT)" suffix dropped to a plain "Breakdate / Time" when only one applies. Excel mode keeps them as two separate columns, since each grid cell holds one value (the **Export** does not — it uses one Breakdate / Time column like the web table: one labelled line per team, VGFX above VEDIT, VGFX purple / VEDIT orange text, and Import reads that format back) — VO (open), Script and Artwork / STB (dates), Audio Guide (dropdown: N/A or a date), Remarks and Total Mats (open), Plug Type (dropdown); Audio rows also have Length and Others (open text, for the Assigned / Done / Resched-cancelled details). Platform, Units, Plug Type and Audio Guide show as coloured pills; every other date/time (Work Date, Script, Artwork / STB) shows as a neutral slate-coloured chip. Table mode has a section-aware add/edit form (Audio-only units show the Audio sheet's columns) and lets a Manager click a **single cell** to edit just that cell — Enter or clicking away saves, Esc cancels, dropdowns save as soon as you pick, a bad value keeps the editor open with the message — saved through `PATCH /api/workload/:id` (one field, so two people editing different cells of a row never overwrite each other); the ⋮ menu → Edit opens the whole-row form, Duplicate opens the same form pre-filled with that row's values (as a new, unsaved row, so saving creates a copy rather than changing the original), and read-only users click a row to view it. Excel mode is an editable grid with batch save (one team tab at a time); every cell is plain text — no date picker, no dropdown, just type or paste — so it behaves like an actual spreadsheet (validation happens on Save, same as any other grid error). Excel mode selects like a spreadsheet: click anywhere in a cell (padding included) to edit it, drag across cells or Shift+click to select just those cells; click a **row number** to select the whole row (drag or Shift+click for several rows), a column header for the whole column, or the top-left corner for everything. **Ctrl+C / Ctrl+X / Ctrl+V** copy, cut and paste whole rows or any range as tab-separated text (so it also pastes to and from a real Excel sheet) — multi-line cells (like Remarks) are quoted the way a real spreadsheet's clipboard does, so line breaks survive. Pasting starts at the top-left of the selection (a selected row starts at its first column), rows pasted past the last row are added as new rows (up to 200 per save), one copied value — or a block that divides the selection evenly — repeats to fill a selected range, and **Delete** clears the selected cells. Only the outline of a range is drawn, and a plain single-cell copy/paste still behaves like a normal text field. **Export** downloads as `Workload_<TAB>_<Month>_<Year>.xlsx` (the tab you exported from, and the month/year the export happened, e.g. `Workload_ALL_Sept_2026.xlsx`) and writes `.xlsx` with a MAIN sheet (VGFX/VEDIT rows) and an AUDIO sheet (needs `npm install` for `exceljs`): a tinted header fill (matching the org's chosen theme), grid lines, black text throughout except Plug Type/Units Concerned which keep their web pill colour as plain coloured text (Platform is black), bold Plug ID and Prog. Name, every cell centred, every column one line except Remarks (which wraps), and every non-Remarks column auto-sized to its widest value so nothing is ever cropped. Table rows are one line each (only Remarks wraps; line breaks in pasted cells show as " · "), so a wide table scrolls sideways inside the card; below 900px each row becomes a card. Table mode has grid lines between columns (spreadsheet-style); cards mode (below 900px) stays borderless since each row is already its own bordered card. Field definitions, per-tab columns and the Platform rules live in `src/routes/workload.js` and reach the UI through `/api/workload/meta`. Platform and Plug Type options are admin-managed (Admin → Dropdowns). Writes need `workload.write` (Manager+). **Priority** — a checkbox at the top of the add/edit form (stored as `workload_items.is_priority`, added automatically on restart); a prioritised row gets its Breakdate / Time cell highlighted red in Table mode, Excel mode and the Excel export (light-red fill on its Breakdate / Time cell(s)) — red so it stays distinct from the VGFX purple and VEDIT orange pills; each Breakdate / Time pill carries a small VGFX or VEDIT label, and a Duplicate starts un-prioritised. **Add Column** (Admin-only, in both Table and Excel mode toolbars) adds a plain open-text column that shows up everywhere — Table, Excel grid, the add/edit form, and the Excel export — for every row; values live in a `custom_fields` JSONB column so adding/removing a column is instant (`POST`/`DELETE /api/admin/workload-columns`), and each added column can be deleted from the same Add Column dialog (Delete next to its name) — deleting only hides it — data already entered stays in the row, just orphaned. **Import** (next to Export, needs `workload.write`) reads a `.xlsx` shaped like this app's own Export (matching column headers; sheet names don't matter, since headers drive the mapping) and creates rows from it — a plug that spans two sheets (e.g. VGFX/VEDIT/Audio) is merged by Work Date + Plug ID into one row rather than duplicated, and a header that doesn't match any known field or existing custom column gets a new custom column created for it automatically. A bad row is reported and skipped rather than failing the whole import. Importing the *original* per-day team template (a different shape entirely) is not supported yet. **Lock Dates** (Admin-only) freezes a date range so its rows can't be edited, deleted, or have new rows created in it, on every write path (create, form save, click-to-edit, batch save, delete, Import) — the lock applies to everyone, Admins included, until an Admin unlocks the range (Lock Dates → Unlock). Anyone sees a clear error naming the lock's note when they try; Duplicate still works on a locked row, since it creates a new, re-datable row rather than changing the original. Upgrading from an earlier Workload build is automatic on restart: Section Assigned becomes Units Concerned; Script / Artwork keep only real dates; the old separate Breakdate (date) and Time columns are merged into one Breakdate/Time (a date without a time becomes 12:00 AM; typed time text is kept in Remarks), which is then itself split into Breakdate / Time (VGFX) and (VEDIT) — assigned by the row's Units Concerned at the time of upgrade, since there's no historical record of which team a single old value belonged to.

## Security

- **Front end:** React escapes all rendered data (no `innerHTML`); the Vite build has no inline scripts, so the strict CSP stays `script-src 'self'`. Each page URL is still checked server-side before `index.html` is returned (locked pages answer 403).

- **Passwords:** bcrypt 6 (cost 12); 8+ chars with letters and numbers, max 72 bytes, rejects common passwords and ones containing the username/name; forced change for new or reset accounts; other sessions signed out on change.
- **2FA (TOTP):** `otplib`; required for Admins by default (`REQUIRE_2FA=admin|all|none`) — required users are held on Profile until enrolled and cannot disable it. Secrets are **AES-256-GCM encrypted at rest** (`TOTP_ENC_KEY`, rotatable via `TOTP_ENC_KEY_OLD`), also encrypted inside the session during setup. **Codes are single-use** (replay-protected per time-step).
- **Login:** one generic error for unknown user / wrong password / locked / disabled (no username enumeration); account lock after 5 failures (15 min); per-IP login rate limit; constant-ish timing.
- **Sessions:** PostgreSQL store, regenerated at login, `HttpOnly`, `SameSite=Lax`, `Secure` + `__Host-` cookie prefix over HTTPS, rolling 12 h. Deactivation / password reset kills sessions.
- **Headers:** Helmet with strict CSP (no inline script/style, `frame-ancestors 'none'`), HSTS 1 year, `Permissions-Policy`, no `X-Powered-By`.
- **CSRF:** state-changing API calls require `X-Requested-With: PromoHub` plus SameSite cookie.
- **Authorization:** role + group checked server-side on every page and API; re-loaded from the DB on every request.
- **Data:** parameterized SQL everywhere; server-side validation; CSV exports guard against formula injection.
- **Uploads:** PNG/JPEG/WebP only, 2 MB, magic-byte verified, random filenames, `nosniff`.
- **Audit log** of logins/failures/locks, every create/update/send/decision, admin and group changes, exports. Append-only for the least-privilege DB login.
- **Least privilege DB:** `db/app-role.sql` creates a DML-only runtime login (no DDL, cannot edit roles or delete audit logs); run the app with `MIGRATE_ON_START=false`.
- **Startup checks:** refuses to start in production without a strong `SESSION_SECRET` or `TOTP_ENC_KEY`; warns on missing `TRUST_PROXY`, `COOKIE_SECURE=false`, `REQUIRE_2FA=none`.
- `npm audit`: 0 known vulnerabilities at time of release.

### Go-live checklist (public internet)

1. TLS at the reverse proxy (see `deploy/nginx.conf`) forwarding `X-Forwarded-Proto`; app listens on 127.0.0.1 by default in production (`HOST`); firewall Postgres off the internet.
2. `.env`: `NODE_ENV=production`, `TRUST_PROXY=1`, fresh `SESSION_SECRET` and `TOTP_ENC_KEY` (store the key in your password manager/secret store), strong `ADMIN_PASSWORD`.
3. Database: owner login for `npm run migrate`; app runs as `promohub_app` from `db/app-role.sql` with `MIGRATE_ON_START=false`.
4. First sign-in as Admin: change password, enrol 2FA. Consider `REQUIRE_2FA=all`.
5. Backups: nightly `pg_dump` + `uploads/branding/`, tested restore. Keep `TOTP_ENC_KEY` with (but separate from) backups.
6. Keep dependencies patched: `npm audit` monthly; run under systemd (`deploy/promo-hub.service`, auto-restart + sandboxing).
7. Get an independent penetration test before announcing the URL.

## Configuration (.env)

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres connection string |
| `SESSION_SECRET` | long random string (`openssl rand -hex 48`), 32+ chars required |
| `TOTP_ENC_KEY` | 64 hex chars (`openssl rand -hex 32`), encrypts 2FA secrets; required in production |
| `TOTP_ENC_KEY_OLD` | previous key, only while rotating |
| `REQUIRE_2FA` | `admin` (default), `all`, `none` |
| `MIGRATE_ON_START` | `false` to skip migrations at boot (least-privilege DB login) |
| `LOGIN_RATE_LIMIT` | login attempts per IP per 15 min (default 20) |
| `PORT` | default 3000 |
| `HOST` | bind address; production default `127.0.0.1`, development `0.0.0.0` |
| `NODE_ENV` | `production` enables secure cookies/HSTS by default |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_FULLNAME`, `ADMIN_EMAIL` | seed Admin (created once if missing) |
| `TRUST_PROXY` | set (e.g. `1`) when behind nginx/Traefik so secure cookies and rate limits see the real client |
| `COOKIE_SECURE` | override; set `false` for plain-HTTP LAN deployments in production mode |
| `SESSION_HOURS` | session lifetime, default 12 |
| `PGSSL` | `true` to connect to Postgres over TLS |

Note: PWA install and service workers require HTTPS (or `localhost`).

## Layout

```
server.js                 app wiring, security headers, page routes behind requirePageAccess
src/permissions.js        CATALOG (pages/sections), ROLE_ACTIONS — the single source of truth
src/middleware.js         loadUser (role + group perms), requirePageAccess, requireSection, requireAction, csrfGuard
src/schema.sql            idempotent schema (runs on every boot)
src/routes/*.js           auth, profile, ingest, approvals, workload, reports, knowledge, dashboard, admin, notifications, branding
client/                   React 18 + Vite front end
  src/App.jsx             routes + client-side page guard (mirrors the server lock)
  src/context.jsx         session (role, group, allowed pages/sections/actions) + branding
  src/components/         TopNav (nav, notifications, user menu), Modal, Confirm, Toast, Pill, Kpi, Bars
  src/pages/              Login, Dashboard, Ingest, Approval, Workload, Reports, Knowledge, Profile, admin/*
  src/lib/                api client (CSRF header, auth redirects), theme engine, utils
  public/                 theme-boot.js, sw.js, manifest, icons, offline page
  dist/                   build output served by Express (index.html only after the access check)
```
