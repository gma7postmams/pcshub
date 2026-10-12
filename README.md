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

Closes the site to everyone except a System Admin, for upgrades and similar work. Everyone else sees an "Under maintenance" page, and their sign-in is refused with a message. The System Admin signs in as usual and sees a "Maintenance ON" badge in the top bar.

- **Flag file (no restart):** `sudo sh -c 'echo "Back at 3 PM" > /var/www/pcshub/MAINTENANCE'` turns it on; the text is the message shown. `sudo rm /var/www/pcshub/MAINTENANCE` turns it off. It takes effect within a second.
- **`.env` (restart needed):** set `MAINTENANCE_MODE=true` (and optionally `MAINTENANCE_MESSAGE`), then `sudo systemctl restart pcshub`. Set it back to `false` to end it.

Either one being on is enough. People already signed in are not signed out: they see the maintenance page until it ends, then carry on.

## Notes

- All settings come from `.env`; `.env.example` lists them with comments. Never commit your real `.env`.
- Take a backup before upgrading (Admin → Backup and Restore).

## Tests

```bash
npm test
```

- **Sign-in card title:** the app name under the logo is 16 px (was 19 px), so a long name like "PCS Updates, Logging & Status Environment" fits on one line inside the white card (and wraps on a phone).
