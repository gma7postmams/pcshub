# Promotional Content Hub

An internal web app for promotional content teams. Built with Node.js (Express), PostgreSQL and React (Vite).

## Top features

- **Ingest Tracker**: track ingest requests with an approval step, statuses, import and export.
- **Workload Tracker**: plan and follow work by day and team, with custom columns.
- **PSD Daily Plug List**: maintain the daily plug list, with Excel import.
- **Live updates**: changes other people save on the three trackers appear on your screen by themselves, without a page refresh.
- **Knowledge Base**: shared reference PDFs with tags and a trash bin.
- **Dashboard**: workload and ingest numbers at a glance, fits the screen.
- **Admin**: users, roles and groups, dropdown lists, branding, security rules, backup and restore, data retention and an audit log.
- **Sign-in protection**: optional two-factor authentication (authenticator app or emailed code), lockout after failed attempts, and session limits.

## Requirements

- Node.js 20 or newer
- PostgreSQL 14 or newer
- nginx (or another reverse proxy) for HTTPS in production

## Run locally

```bash
cp .env.example .env     # fill in the values described inside the file
npm install
npm run build            # builds the front end
npm start                # creates the tables and the first Admin on first start
```

For front-end development, run `npm start` and `npm run dev:client` in two terminals.

## Deploy

1. **Get the code** onto the server and install: `npm ci --omit=dev`, then `npm run build`. (You can build on another machine and copy `client/dist/`.)
2. **Configure**: copy `.env.example` to `.env`, fill in every required value, and restrict the file (`chmod 600 .env`).
3. **Database**: create an empty PostgreSQL database and a login for the app, then point the app at it (see below). Tables are created on first start.
4. **Run as a service**: use the example unit in `deploy/` with systemd, then enable and start it.
5. **HTTPS**: put nginx in front using the example in `deploy/`, and set `TRUST_PROXY` and `APP_ORIGIN` in `.env` as described in `.env.example`.
6. **First sign-in**: sign in with the seeded Admin, choose a new password, then set up groups, users and dropdown lists in Admin.

**Upgrading**: pull the new code, run `npm install --omit=dev` and `npm run build`, then restart the service. Run `npm install` again whenever `package.json` changes.

## Connect to the database

1. Create a database and a login (run as the PostgreSQL admin, and choose your own strong password):

   ```bash
   sudo -u postgres psql -c "CREATE ROLE hub_user LOGIN PASSWORD 'choose-a-strong-password';"
   sudo -u postgres psql -c "CREATE DATABASE hub OWNER hub_user;"
   ```

2. Put the connection string in `.env`:

   ```
   DATABASE_URL=postgresql://hub_user:choose-a-strong-password@localhost:5432/hub
   ```

   If the password contains special characters such as `@` or `#`, URL-encode them. Set `PGSSL=true` if the database is on another server and requires TLS.
3. Start the app. It connects and creates its tables automatically. If it cannot connect, the log (`journalctl -u <service-name> -n 30`) names the problem.
4. To check the connection by hand: `psql "$DATABASE_URL" -c "select 1"`.

## Maintenance mode

Closes the site to everyone except a System Admin, for upgrades and similar work. Everyone else sees an "Under maintenance" page, and their sign-in is refused with a message. The System Admin signs in as usual and sees a "Maintenance: ON" badge in the top bar.

- **In the app (no restart):** as a System Admin open Administration → Maintenance, optionally type a message, and press **Turn on maintenance mode** (and **Turn off** to end it). Every change is written to the Audit Log.
- **Flag file (no restart):** `sudo sh -c 'echo "Back at 3 PM" > /var/www/pcshub/MAINTENANCE'` turns it on; the text is the message shown. `sudo rm /var/www/pcshub/MAINTENANCE` turns it off. It takes effect within a second.
- **`.env` (restart needed):** set `MAINTENANCE_MODE=true` (and optionally `MAINTENANCE_MESSAGE`), then `sudo systemctl restart pcshub`. Set it back to `false` to end it.

Any one of the three being on is enough, so if it stays on after you turn it off in the app, check the flag file and `.env`. People already signed in are not signed out: they see the maintenance page until it ends, then carry on.

## Notes

- All settings come from `.env`; `.env.example` lists them with comments. Never commit your real `.env`.
- Take a backup before upgrading (Admin → Backup and Restore).

## Tests

```bash
npm test
```

- **Sign-in card title:** the app name under the logo is 16.5 px (was 19 px), so a long name like "PCS Updates, Logging & Status Environment" fits on one line inside the white card (and wraps on a phone).

- **Users and Groups: Export JSON / Import JSON** (Administration → Access → Users and Groups, System Admin only; same buttons as Dropdowns). *Export* downloads `users-DATE.json` / `groups-DATE.json`; a users file has username, full name, email, role, group name and active flag — never passwords, 2FA secrets or sessions. *Import* only **adds**: a group is matched by name and a user by username (case-insensitive), anything already there is left exactly as it is and counted, and nothing is ever deleted or changed. Import the **Groups** file first — a user whose group isn't there yet is skipped and the message says why. New users get a random password nobody knows and must choose their own at first sign-in, so give each person one with **Manage → Reset password**. Both actions are in the Audit Log (Exported / Imported Users / Groups). Roles are not included.

- **Name in the email codes:** the subject and text of the emailed sign-in / confirmation codes (`123456 is your PULSE code`) use `MAIL_APP_NAME` from `.env` if it is set; otherwise the sender name in `SMTP_FROM` without a trailing "Notifications" (`PULSE Notifications <…>` → `PULSE`); with no name there, the app name from Administration → Branding. The sender name in the inbox stays whatever `SMTP_FROM` says. Before, the emails always said "Promotional Content Hub". Restart the service after changing `.env`.
- **Code email layout:** the emailed sign-in / confirmation code is now a small styled page, like the other notification emails: the Branding logo (attached to the email, so it shows without the app being reachable), the app name from Branding ("PCS Updates, Logging & Status Environment") as the blue heading (the short name, e.g. PULSE, is used in the sentence below it), then "Your PULSE sign-in code is:" with the code large, and the 10-minute note. A plain-text version is still sent for mail programs that don't show HTML.
- **Empty preview line:** the code email starts with a hidden run of blank characters, so the inbox list's preview (the grey line under the subject) is empty instead of showing the first words of the email. How empty it looks depends on the mail program.
- **Code email speed and size:** the logo is attached to every code email, so a big logo file makes the email slow to send (a 1.5 MB logo means a 2 MB email). Upload a small logo in Administration → Branding (under about 100 KB is plenty; the email shows it 130 px tall). The name and logo are read once a minute, not on every email. 
