# Promotional Content Hub

An internal web app for promotional content teams. Built with Node.js (Express), PostgreSQL and React (Vite).

## Top features

- **Ingest Tracker**: track ingest requests with an approval step, statuses, import and export.
- **Workload Tracker**: plan and follow work by day and team, with custom columns.
- **PSD Daily Plug List**: maintain the daily plug list, with Excel import.
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
3. **Database**: create an empty PostgreSQL database and a login for the app, and set `DATABASE_URL`. Tables are created on first start.
4. **Run as a service**: use the example unit in `deploy/` with systemd, then enable and start it.
5. **HTTPS**: put nginx in front using the example in `deploy/`, and set `TRUST_PROXY` and `APP_ORIGIN` in `.env` as described in `.env.example`.
6. **First sign-in**: sign in with the seeded Admin, choose a new password, then set up groups, users and dropdown lists in Admin.

**Upgrading**: pull the new code, run `npm install --omit=dev` and `npm run build`, then restart the service. Run `npm install` again whenever `package.json` changes.

## Notes

- All settings come from `.env`; `.env.example` lists them with comments. Never commit your real `.env`.
- Take a backup before upgrading (Admin → Backup and Restore).

## Tests

```bash
npm test
```
