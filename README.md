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

**Workload** — one table (`workload_items`) for every team, following the Sept 2026 PCS Workload template. **Units Concerned** (dropdown: VGFX Only, VEDIT Only, VGFX/VEDIT, Audio - RADIO, Audio – AUDIO GUIDE, VGFX/VEDIT/Audio) says which team(s) a plug is for; the page tabs (All / VGFX / VEDIT / Audio) show counts that follow the active filters and are filters over it themselves. Columns and field types come from the template's red notes: Platform (dropdown, auto-filled from the Plug ID prefix — same rules as the template's formula; PD_ plugs are set by hand to DIGITAL / INTL DIGITAL), Billable Party (open), Plug ID / PSD / Prog. Name (pasted from the PSD daily plug list), **Breakdate / Time** — one column/field in Table mode and the form, holding two underlying timestamps (VGFX's and VEDIT's) with no time zone; a row shows one pill when only one of those teams is involved, or two pills stacked one above the other (VGFX on top, VEDIT below; VGFX purple, VEDIT orange — the same colours as their pill in Units Concerned) when both are; each pill is its own click target, editing just that team's time. The form mirrors this: only the field(s) for a row's actual team(s) are shown, with the "(VGFX)"/"(VEDIT)" suffix dropped to a plain "Breakdate / Time" when only one applies. Excel mode now uses ONE Breakdate / Time cell too: it shows a `VGFX  Sep 28, 2026 4:00 PM` line and a `VEDIT  …` line, and whatever is typed or pasted there is read back into the two times (the **Export** also uses one column — it uses one Breakdate / Time column like the web table: one labelled line per team, VGFX above VEDIT, VGFX purple / VEDIT orange text, and Import reads that format back) — VO (open), Script and Artwork / STB (dates), Audio Guide (dropdown: N/A or a date), Remarks and Total Mats (open), Plug Type (dropdown); Audio rows also have Length and Others (open text, for the Assigned / Done / Resched-cancelled details). Platform, Units, Plug Type and Audio Guide show as coloured pills; every other date/time (Work Date, Script, Artwork / STB) shows as a neutral slate-coloured chip. Table mode has a section-aware add/edit form (Audio-only units show the Audio sheet's columns) and lets a Manager click a **single cell** to edit just that cell — Enter or clicking away saves, Esc cancels, dropdowns save as soon as you pick, a bad value keeps the editor open with the message — saved through `PATCH /api/workload/:id` (one field, so two people editing different cells of a row never overwrite each other); the ⋮ menu → Edit opens the whole-row form, Duplicate opens the same form pre-filled with that row's values (as a new, unsaved row, so saving creates a copy rather than changing the original), and read-only users click a row to view it. Excel mode is an editable grid with batch save (one team tab at a time); every cell is plain text — no date picker, no dropdown, just type or paste — so it behaves like an actual spreadsheet (validation happens on Save, same as any other grid error). Excel mode selects like a spreadsheet: click anywhere in a cell (padding included) to edit it, drag across cells or Shift+click to select just those cells; click a **row number** to select the whole row (drag or Shift+click for several rows), a column header for the whole column, or the top-left corner for everything. **Ctrl+C / Ctrl+X / Ctrl+V** copy, cut and paste whole rows or any range as tab-separated text (so it also pastes to and from a real Excel sheet) — multi-line cells (like Remarks) are quoted the way a real spreadsheet's clipboard does, so line breaks survive. Pasting starts at the top-left of the selection (a selected row starts at its first column), rows pasted past the last row are added as new rows (up to 200 per save), one copied value — or a block that divides the selection evenly — repeats to fill a selected range, and **Delete** clears the selected cells, **Esc** drops the selection, **Enter** / Shift+Enter move down / up a cell, and **right-click** opens Undo / Redo / Cut / Copy / Paste / Delete (plus Insert copied row(s) above and Delete row(s) when whole rows are selected); **Ctrl+Z / Ctrl+Y** undo and redo (one step per cell edit, paste, clear or row add; not across a Save or a saved-row delete); clicking outside the grid drops the selection (the cell itself is the editor — no separate edit box; on an address the browser treats as insecure, i.e. plain http, the menu's Paste can't read the system clipboard and uses what was last copied in the grid, so use Ctrl+V for text copied elsewhere). Pasting a Breakdate / Time cell that holds both teams (a `VGFX …` line and a `VEDIT …` line, as in the Excel export or copied from the web table) into any selected cell or row fills that row's VGFX and VEDIT times together instead of adding rows (whole rows copied from the Excel export are split the same way, so their remaining columns line up); a single date/time pasted there (e.g. `Sep 28, 2026 4:00 PM`) is converted to the grid's format. Only the outline of a range is drawn, and a plain single-cell copy/paste still behaves like a normal text field. **Export** downloads as `Workload_<TAB>_<Month>_<Year>.xlsx` (the tab you exported from, and the month/year the export happened, e.g. `Workload_ALL_Sept_2026.xlsx`) and writes `.xlsx` with a MAIN sheet (VGFX/VEDIT rows) and an AUDIO sheet (needs `npm install` for `exceljs`): a tinted header fill (matching the org's chosen theme), grid lines, black text throughout except Plug Type/Units Concerned which keep their web pill colour as plain coloured text (Platform is black), bold Plug ID and Prog. Name, every cell centred, every column one line except Remarks (which wraps), and every non-Remarks column auto-sized to its widest value so nothing is ever cropped. Table rows are one line each (only Remarks wraps; line breaks in pasted cells show as " · "), so a wide table scrolls sideways inside the card; below 900px each row becomes a card. Table mode has grid lines between columns (spreadsheet-style); cards mode (below 900px) stays borderless since each row is already its own bordered card. Field definitions, per-tab columns and the Platform rules live in `src/routes/workload.js` and reach the UI through `/api/workload/meta`. Platform and Plug Type options are admin-managed (Admin → Dropdowns). Writes need `workload.write` (Manager+). **Priority** — a checkbox at the top of the add/edit form (stored as `workload_items.is_priority`, added automatically on restart); a prioritised row gets its Breakdate / Time cell highlighted red in Table mode, Excel mode and the Excel export (light-red fill on its Breakdate / Time cell(s)) — red so it stays distinct from the VGFX purple and VEDIT orange pills; each Breakdate / Time pill carries a small VGFX or VEDIT label, and a Duplicate starts un-prioritised. **Add Column** (Admin-only, in both Table and Excel mode toolbars) adds a plain open-text column that shows up everywhere — Table, Excel grid, the add/edit form, and the Excel export — for every row; values live in a `custom_fields` JSONB column so adding/removing a column is instant (`POST`/`DELETE /api/admin/workload-columns`), and each added column can be deleted from the same Add Column dialog (Delete next to its name) — deleting only hides it — data already entered stays in the row, just orphaned. **Import** (next to Export, needs `workload.write`) reads a `.xlsx` shaped like this app's own Export (matching column headers; sheet names don't matter, since headers drive the mapping) and creates rows from it — a plug that spans two sheets (e.g. VGFX/VEDIT/Audio) is merged by Work Date + Plug ID into one row rather than duplicated, and a header that doesn't match any known field or existing custom column gets a new custom column created for it automatically. A bad row is reported and skipped rather than failing the whole import. Importing the *original* per-day team template (a different shape entirely) is not supported yet. **Lock Dates** (Admin-only) freezes a date range so its rows can't be edited, deleted, or have new rows created in it, on every write path (create, form save, click-to-edit, batch save, delete, Import) — the lock applies to everyone, Admins included, until an Admin unlocks the range (Lock Dates → Unlock). Anyone sees a clear error naming the lock's note when they try; Duplicate still works on a locked row, since it creates a new, re-datable row rather than changing the original. Upgrading from an earlier Workload build is automatic on restart: Section Assigned becomes Units Concerned; Script / Artwork keep only real dates; the old separate Breakdate (date) and Time columns are merged into one Breakdate/Time (a date without a time becomes 12:00 AM; typed time text is kept in Remarks), which is then itself split into Breakdate / Time (VGFX) and (VEDIT) — assigned by the row's Units Concerned at the time of upgrade, since there's no historical record of which team a single old value belonged to.

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

### Import / export audit hook (for whoever owns the audit log)

The Import and Export buttons — **Workload Import**, **Workload Export** and the PSD Daily Plug List **Import plug list** — do **not** write to the audit log themselves; that part belongs to someone else. Instead, each run (and each failure) is announced through one small module, `src/transfer-hook.js`, and the audit owner subscribes once:

```js
const { onTransfer } = require('./src/transfer-hook');
onTransfer((e) => audit(e.req, e.action, e.entity, e.entityId, e.details));   // e.g. in server.js, once the audit module is loaded
```

Nothing is wired up yet, so until that line is added these actions simply don't appear in the audit log. (One line per event is also written to the server log — `journalctl -u pcshub -f` — whether or not anything is subscribed.)

**Events** (`e.action`): `workload.export`, `workload.export_failed`, `workload.import`, `workload.import_failed`, `workload.plugs_import`, `workload.plugs_import_failed` — the list is exported as `TRANSFER_ACTIONS`.

**The event** `e`: `action` · `entity` (`'workload_transfer'`, a suggested value for `audit()`'s entity argument) · `entityId` (`null`) · `user` (`{ id, username, role }` or `null`) · `ip` · `at` (ISO time) · `req` (the Express request, so `audit(req, …)` works exactly as elsewhere in the app) · `details`:

| action | `details` |
|---|---|
| `workload.export` | `format`, `team`, `filters`, `matched`, `truncated` (hit the 20,000-row cap), `sheets` (rows per sheet), `file`, `bytes`, `ms` |
| `workload.import` | `file`, `bytes`, `sheets` (`[{ name, rows }]`), `rowsRead`, `uniqueRows`, `created`, `skipped`, `errors` (first 20 skip reasons), `newColumns`, `ms` |
| `workload.plugs_import` | `target`, `file`, `bytes`, `year`, `days`, `from`, `to`, `plugs`, `added`, `skipped`, `workloadRowsFilled`, `warnings`, `ms` |
| `*_failed` | what was known at the time (`file`, `bytes`, `team` / `filters` …) plus `error` and `ms` |

Row contents are never included. Listeners may be async; one that throws or rejects is logged and ignored, so it can never break an import or export. `onTransfer` returns a function that unsubscribes.

Separately, the other actions added to Workload and the plug list — bulk delete / **Delete all…**, **Copy to Workload**, **Fill blank rows** — are ordinary action logs written through the existing `audit()` helper (`workload.bulk_delete`, `workload.plugs_copy`, `workload.plugs_fill`, `workload.plugs_delete_all`), like the app's other create / edit / delete entries; each imported Workload row still gets its own `workload.create` entry, flagged `imported`.

### PSD Daily Plug List (its own page, next to the Workload Tracker)

The **PSD Daily Plug List** page (top navigation, right after the Workload Tracker; `/plug-list`) holds the PSD's daily plug list. The table has a **NO** column first, then a **DATE** column of its own (then PLUG ID / PROG. NAME / PROJ. TITLE / PSD / Account By), and two dropdowns control what you see: **View** — *All*, *Daily*, *Weekly* (Monday–Sunday), *Monthly* or *Custom range* (with ‹ › to step to the previous / next day that has a list, week or month) — and **Rows**, how many rows are visible per page (25 / 50 / 100 / 250 / 500 / All, up to 5,000 at once; the choices are remembered). *All* lists the newest day first. Search works within the current view. The Workload Tracker copies **Plug ID, PSD and PROG. NAME / PROJ. TITLE** from it.

- **Import plug list** reads the PSD's workbook (one sheet per day; each sheet's date comes from its "DATE:" line, else the sheet name). The year isn't in the sheet, so it is taken from the file name (`September_2026_…`) or asked for. Re-importing an updated file only adds what is new; late additions under “Additional for …” are marked *Added*; exact duplicate lines are dropped. The import is announced on the import / export hook (`workload.plugs_import`, see above).
- **Existing rows get filled too**: a Workload row that already has a Plug ID but a blank PSD or PROG. NAME / PROJ. TITLE is filled in from that day's list — automatically after a plug list is imported or a plug is added / edited, once at every server start, and on demand with **Fill blank rows** (on the plug list page; `workload.plugs_fill` in the audit log). Only blanks are filled (nothing typed is overwritten), the Plug ID matches in any letter case (for a multi-line Plug ID cell, the first line), and rows in a locked date range are left alone.
- **New / Edit Workload has no free-text Plug ID**: the field is a dropdown of the plugs on the PSD Daily Plug List for the chosen Work Date (“PLUG_ID — program · PSD”). Choosing one fills PSD, PROG. NAME / PROJ. TITLE and the platform; changing the Work Date clears the choice, since another day has another list; a day with no list yet says so (with a link to the plug list page) and can't be saved. A row saved earlier with a Plug ID that isn't on the list shows it as “(not on this day's list)” and can still be saved unchanged. In Table mode, clicking a Plug ID cell opens the edit form for the same reason. Excel mode, Import and the Table-mode paste still take a typed / pasted Plug ID (they fill PSD / PROG. NAME when it matches the list).
- **Autofill**: in Excel mode when you type or paste a Plug ID, and on the server whenever a row is saved with those two left blank (forms, Excel grid, Workload import). Values you type yourself are kept; ones that were filled in are replaced if you change the Plug ID.
- **Copy to Workload** makes a Workload row for each selected plug — from any days — or, with nothing selected, for every plug in the current view (up to 5,000) that isn't in the tracker yet with Plug ID, PSD and PROG. NAME / PROJ. TITLE filled in. **Units Concerned is left blank** (the plug list doesn't say which team a plug is for): those rows show only under the **All** tab, marked “Set units”, until someone chooses the team(s) — click the Units cell or edit the row — and then they appear under the matching VGFX / VEDIT / Audio tabs. The Units filter's “(Not set)” finds the ones still waiting, and an export puts them on an `UNASSIGNED` sheet (which Import reads back). A row that has units can't be blanked, and a row you add by hand still needs them. Copy skips plugs that already have a row for that day, respects locked dates, and is logged (`workload.plugs_copy`).
- **Add plug**, **Edit** and **Delete** (on every row) change a day's list by hand. Editing can fix any field, including the Plug ID or the day (the list follows the plug to its new day); Workload rows already filled from the old values keep what they have, and any Workload row with a blank PSD / PROG. NAME that now matches gets filled in. Edits are logged (`workload.plug_edit`). **Delete all…** (Admin only) clears everything in the current view (e.g. one week) or every day's plugs, after typing `DELETE`; Workload rows already made from the list are not touched. It is logged (`workload.plugs_delete_all`).

**Access.** The page is granted to a *group* like any other (Admin → Groups → Pages → “PSD Daily Plug List”); the first time this version starts, every group that can open the Workload Tracker is given it too, so nobody loses access (untick it per group afterwards — it isn't re-added). Anyone who can open either the plug list page or the Workload Tracker can *read* the list (the tracker uses it to fill PSD / PROG. NAME). Changing it — import, add, edit, delete, delete all — needs the new `plugs.write` action (Manager or Admin **and** the plug list page; delete all is Admin only). **Copy to Workload** and **Fill blank rows** also need `workload.write`, because they create / change Workload rows. The API moved from `/api/workload/plugs` to `/api/plugs`.
- The Workload column formerly named “Prog. Name / Project Title” is now **PROG. NAME / PROJ. TITLE** (Import still understands files exported under the old name).

### Table mode: selecting, deleting and keyboard shortcuts

Table mode selects rows the way Excel mode selects cells — no tick boxes and no Select all button.

- **Select rows**: press on a row and **drag** across the rows you want; **Shift+click** extends a range; **Ctrl/Cmd+click** adds or removes one row. A plain click on a cell still opens that cell for editing, and clicking outside the table (or pressing **Esc**) drops the selection. Rows in a locked period can't be selected.
- **Select all is Ctrl/Cmd+A only**: in Table mode it selects every row on the page (press again for every matching row — Admin); in Excel mode it selects every cell of the grid, even with the cursor inside a cell.
- **Right-click a row** (Table mode) for the same menu as Excel mode: Undo, Redo, Cut, Copy, Paste, Delete. (On a plain-http address the browser won't let the menu read the system clipboard, so its Paste uses the rows last copied in the app; Ctrl+V works for anything copied elsewhere.)
- **Shortcuts** (the same as Excel mode; not while typing in a field or a cell editor): **Ctrl+C** copy the selected rows as tab-separated text (pastes into Excel mode or a spreadsheet) · **Ctrl+X** cut (copy, then delete after a confirmation) · **Ctrl+V** paste rows from the clipboard as new Workload rows (after a confirmation) · **Ctrl+Z / Ctrl+Y** undo / redo a delete, cut, paste or single-cell edit · **Delete** delete the selected rows (after a confirmation) · **Esc** clear.
- Table mode saves straight to the server, so undo works by doing the opposite on the server: undoing a delete re-creates the rows as new rows (new IDs), undoing a paste deletes what it added. Undo history is kept until the page is reloaded; deleting everything with **Delete all…** can't be undone.
- **Delete selected** and **Delete all…** (Admin only; type `DELETE` to confirm) skip rows in a locked period and say how many, and are logged (`workload.bulk_delete`).
- The Units / Platform / Plug Type filters are the app's own dropdowns (keyboard: arrows, Enter, Esc, type a letter to jump), so the values are padded and themed instead of using the browser's plain popup.

### Logo: login page and browser tab

- The logo on the sign-in page is twice its old size (112 px tall, up to 320 px wide); the initials mark used when there is no logo grew to match.
- The **browser-tab icon** is the logo uploaded on **Admin → Branding**, with a transparent background. It is made in the browser from that logo: a plain solid backdrop (a white or coloured box around the artwork) is removed from the edges inwards — white *inside* the artwork is kept — the empty margin is trimmed, and the result is centred on a 64×64 PNG. A logo that is already transparent is only trimmed and squared. It is cached per logo, so a newly uploaded logo gets a fresh icon; with no logo the built-in icon is used. (A logo whose corners are not one plain colour, such as a photo, is used as it is.) The installed-app / home-screen icons (`manifest.webmanifest`) are not changed.

### Artwork / STB: a date or plain text

The **Artwork / STB** field takes either a **date** (a date picker) or **text** (an open text box): a small **Date / Text** dropdown sits beside the box, in the New / Edit form and when you click the cell in Table mode (an empty one starts as a Date, as the column always did; switching clears the box, since the two don't convert into each other). It is stored as one value — `YYYY-MM-DD` for a date, anything else for text (up to 200 characters, one line; a date-shaped value must be a real date). In Table mode a date shows as a date chip and text as plain text; in Excel mode the cell is just a text cell (type `2026-10-09` or any text); the Export writes a date as a real Excel date and text as text, and Import reads either back. The database column changed from `DATE` to `TEXT`; the first start of this version converts it in place and keeps every existing date as `YYYY-MM-DD`.

### Dashboard

The Dashboard follows a design mockup: a greeting banner (sun, name, date, a clapperboard illustration), then **Active users** beside **Quick Links**, the **Workload Tracker** card with four tinted KPI cards, **Workload by day** beside **By team**, and an **Ingest & Approval** card with four KPI cards. Every block shows only if the signed-in user may see it, the page refreshes every minute, and it **adapts to the screen**: on a wide window it uses two columns and the chart row grows into the spare height (a 1665×944 window fits without scrolling, like the mockup); on a short window (a laptop at 125% scaling, about 740 px tall) everything shrinks a size so it still fits; below about 980 px the blocks stack, and on a phone the cards go one per row. The top navigation got an icon on every link (shown from 1620 px wide; text-only down to 1280 px; the menu button below that) and the user button now stacks name over role with a chevron.

- **Active users** (the Dashboard section *Active users*, granted per group under Admin → Groups) — a card per person working in the app right now, with their role and the page they are on; a card opens that page if you can open it too. With **one or two people** they show as full cards; from **three** they switch to smaller cards in more columns so the block stays about as tall (it fits six people in two rows on a 1665 px window and eight on 1920 px; anyone beyond that scrolls inside the card, and on a phone they stack in one column). **Earlier today** is a small pill in the card header — hover or focus it for the names. “Active” means their app sent a heartbeat within the last 3 minutes: the app sends a small heartbeat (`POST /api/presence`, about once a minute and when changing page) **only while the person is actually using it** — mouse, keys, touch or scroll in the last two minutes, tab visible — so an idle open tab doesn't count (stored one row per user in `user_presence`). A person drops off the list **at once** when they sign out (logout removes their row) or close the tab / browser (the page sends `POST /api/presence/leave` as it unloads); after a crash or power cut they fall off when the 3-minute window runs out. The block refreshes every 10 seconds (`GET /api/dashboard/users`), the Dashboard records that you are on it *before* it loads, and your own card always says you are on the Dashboard. *Earlier today* lists anyone active in the last 24 hours. Disabled accounts are left out.
- **Quick Links** — always a single row: one tile each for the Ingest Tracker, Workload Tracker, PSD Daily Plug List, Approval and Reports, only for the pages you can open; the tiles share the width and shrink with the screen (icon beside the label when there is room, stacked and smaller when there isn't). The top-row cards are each only as tall as their own content.
- **Workload Tracker** — *Today*, *This week* (Monday–Sunday), *Breakdates in the next 7 days* and *Priority* (each opens the tracker). The **This week ▾** menu at the top right chooses the days **Workload by day** covers: *This week* (the past week and the week ahead), *This month*, *Last 30 days* or *Next 30 days* (`GET /api/dashboard/days?range=…`; your choice is remembered). The chart has a y axis and gridlines, past days muted, upcoming days in the accent colour, today picked out, weekends lightly shaded, the total in view, daily average and busiest day, and a hover tooltip. **By team** counts items per VGFX / VEDIT / Audio (a VGFX/VEDIT item counts for both).
- **Ingest & Approval** (the Dashboard section *Ingest KPIs*) — total, pending, approved and rejected, each opening the related list.

The first start of this version gives *Active users* to every group that can open the Dashboard (untick it per group afterwards; it isn't re-added) and retires the old *Recent ingest activity* section. “Today” and “This week” follow the server's clock.

**Note on gated accounts.** An account that must change its password (or set up required 2FA) is only allowed to call the Profile and Notifications APIs. The presence heartbeat is therefore **not sent** for those accounts, and background calls (`post` / `get` with `{ quiet: true }`) never redirect the browser; before this, the heartbeat sent from the Profile page was refused with “password change required”, which redirected to Profile, which sent it again — a reload loop that stopped the forced password-change page from loading.

### Who is on the Workload Tracker

The top right of the **Workload Tracker** page shows a row of round avatars — like the collaborators at the top of a Google Sheet — for everyone who is on that page right now (you included, with an accent ring). Hover an avatar to see the name; more than six collapse into a “+N” bubble whose tooltip lists the rest. There are no profile pictures in the app, so each avatar is the person's initials on a colour of their own. It uses the same presence signal as the Dashboard's *Active users* (`user_presence`, “active” = used the app in the last 5 minutes) and refreshes every 30 seconds; `GET /api/presence?path=/workload` answers it for anyone who can open that page, and only lists people currently on that same page. Nothing is shown when you are the only one. Disabled accounts are left out.
