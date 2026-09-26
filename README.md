# Promotional Content Hub

Multi-user tracker for promotional content: **Ingest Tracker → Approval**, **Work Load Tracker**, Reports, Dashboard, Admin.
Node.js (Express) + PostgreSQL · dark UI · top navigation only · mobile-ready PWA · no AI.

## Quick start

```bash
cp .env.example .env          # set DATABASE_URL, SESSION_SECRET, ADMIN_USERNAME / ADMIN_PASSWORD
npm install
npm start                     # creates tables + seeds the Admin on first boot
```

Open `http://localhost:3000`, sign in with the seeded Admin, set a new password (forced on first login), then:

1. **Admin → Dropdowns**: add PROGRAM values (Platform has starter values).
2. **Admin → Groups**: create groups and tick the pages/sections each can open.
3. **Admin → Users**: create users, set their role, enroll them in a group.

### Docker

```bash
cp .env.example .env   # fill SESSION_SECRET, TOTP_ENC_KEY, ADMIN_PASSWORD, POSTGRES_PASSWORD
docker compose up -d --build
```

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
| Work Load Tracker | — |
| Approval | — |
| Reports | Ingest & Approval summary · CSV export |

A section only takes effect if its page is also checked.

**Role actions** (`ROLE_ACTIONS`)

| Action | Needs page | Admin | Manager | Editor | Viewer |
|--------|-----------|:-----:|:-------:|:------:|:------:|
| Create / edit / send ingest | Ingest | ✓ | ✓ | ✓ | — |
| Delete ingest | Ingest | ✓ | — | — | — |
| Approve / reject | Approval | ✓ | ✓ | — | — |
| Edit Work Load (when built) | Work Load | ✓ | ✓ | — | — |
| Users, groups, dropdowns, branding, audit | Admin | ✓ | — | — | — |

Adding a new page or section: add it to `CATALOG`, then guard its route with `requirePageAccess(path)` or `requireSection(key)`. It then shows up as a checkbox in Admin → Groups automatically.

**Upgrading from the first version**: on startup the old `users.group_name` (which held Admin/Manager/Editor/Viewer) is migrated to `users.role`, and `groups` is recreated as enrolment groups. Existing non-Admin users start **Not enrolled** (Profile only) until you assign them a group.

## Themes & appearance

- **Theme (Admin → Branding, applies to everyone):** Midnight, Sunset, Purple, Ocean, Forest, Rose, Graphite. Each theme tints backgrounds and sets an accent tuned for readable contrast in both dark and light. Optional **custom accent** overrides the theme accent; button text colour is chosen automatically for contrast.
- **Appearance (per user):** Dark, Light or **System** (follows the device and switches live). Set in Profile → Appearance or the user menu; saved to the user's account (`users.appearance`).
- Implementation: `html[data-theme]` + `html[data-mode]` CSS variables in `public/css/app.css`; `public/js/theme-boot.js` applies the last-known theme in `<head>` so pages don't flash. Adding a theme = one CSS block + one entry in `src/themes.js` (and a swatch in `public/js/admin.js`).

## Workflow

**Ingest** — fields: PROGRAM, Platform (Admin-managed dropdowns), Episode date, Source, Destination Folder, Requested by (active users), Requested by (PSD), Remarks.
Status is the approval state and is never set by the client:

`New` → *Send for Approval* → `Pending Approval` → `Approved` / `Rejected`

- Records are editable only while `New` or `Rejected`. A rejected record can be edited and resubmitted (a new approval request is opened; full history is kept).
- Every approval request references an `ingest_record_id` (NOT NULL FK); only one pending request per record (partial unique index).
- Managers/Admins are notified on send; the sender, creator and "Requested by" user are notified on decision. Rejection requires a reason.

**Work Load** — page (opened by any group that has it checked; editing will need Manager+ role) and the `workload_items` table (identity/audit columns only) are in place. **Fields are not defined yet**; the page shows an empty placeholder with Table / Excel mode toggles. To build it out: add columns in `src/schema.sql`, list them in `FIELDS` in `src/routes/workload.js`, implement list + batch save guarded by `requireAction('workload.write')`, and render them in `public/js/workload.js`.

## Security

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

1. TLS at the reverse proxy (see `deploy/nginx.conf`) forwarding `X-Forwarded-Proto`; app bound to localhost only; firewall Postgres off the internet.
2. `.env`: `NODE_ENV=production`, `TRUST_PROXY=1`, fresh `SESSION_SECRET` and `TOTP_ENC_KEY` (store the key in your password manager/secret store), strong `ADMIN_PASSWORD`.
3. Database: owner login for `npm run migrate`; app runs as `promohub_app` from `db/app-role.sql` with `MIGRATE_ON_START=false`.
4. First sign-in as Admin: change password, enrol 2FA. Consider `REQUIRE_2FA=all`.
5. Backups: nightly `pg_dump` + `uploads/branding/`, tested restore. Keep `TOTP_ENC_KEY` with (but separate from) backups.
6. Keep dependencies patched: `npm audit` monthly; run behind a process manager (systemd/pm2/docker `restart: unless-stopped`).
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
src/routes/*.js           auth, profile, ingest, approvals, workload, reports, dashboard, admin, notifications, branding
views/*.html              page shells (served only after the group check)
public/js/*.js            per-page client code, common.js renders the filtered top nav
public/sw.js, manifest    PWA
```
