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
- **Code email layout:** the emailed sign-in / confirmation code is now a small styled page, like the other notification emails: no logo, just the app name from Branding ("PCS Updates, Logging & Status Environment") as the black heading (the short name, e.g. PULSE, is used in the sentence below it), then "Your PULSE sign-in code is:" with the code large, and the 10-minute note. A plain-text version is still sent for mail programs that don't show HTML.
- **Empty preview line:** the code email starts with a hidden run of blank characters, so the inbox list's preview (the grey line under the subject) is empty instead of showing the first words of the email. How empty it looks depends on the mail program.
- **Code email heading:** the big black line is `MAIL_HEADING` from `.env` if set (e.g. `MAIL_HEADING="PCS Updates, Logging & Status Environment"`), else the app name in Administration → Branding. If Branding's app name is just "PULSE", the heading is "PULSE" until `MAIL_HEADING` is set. There is no logo in the email (it made the email bigger and slower to send). The heading is black and 20 px.
- **Plug list import accepts the Export file:** the PSD Daily Plug List's own Export (one sheet with a DATE column on every row, plus Requested By) can now be imported back, e.g. to restore or move the list to another server. Each row goes to the day in its DATE column, and Requested By is kept. Re-importing only adds what is missing. Before, only the PSD's one-sheet-per-day workbook worked, so this file gave "No plugs found".
- **Plug list import finds the date more often:** the sheet's date is read from the rows above the table as text ("September 28", "Sept. 28", "28 September", "9/28/2026") or as a real Excel date, else from the sheet name. If none is found, the warning now lists what those rows say, so you can see what is in the file.
- **Security rules layout:** "Require 2FA for every Admin" and "Allow email codes for 2FA" are each on their own line (they sat side by side before).
- **Name in authenticator apps:** a new authenticator-app enrolment (Google Authenticator etc.) is labelled with the short name, PULSE (from `MAIL_APP_NAME`, else the sender name in `SMTP_FROM` without "Notifications"), plus the username, instead of the long Branding name. Existing entries in people's apps keep their old label; to change one, switch 2FA off and enrol again. How the issuer and username are laid out ("PULSE: jdoe" or "PULSE (jdoe)") is decided by the authenticator app.
- **Viewers can copy rows in the Workload Tracker:** a Viewer (read-only) now gets the row numbers on the left of the table: click one (Shift-click a range, Ctrl-click to add), then Ctrl+C or right-click → Copy, and paste into Excel. Dragging over cells and copying a block works too. Cut, paste, delete and undo stay for people who can edit. Clicking a cell still opens the row's details.
- **Ingest Tracker deleting:** an Admin / System Admin can delete any request, including ones marked DONE or NON-COMPLIANT in CM (before, NON-COMPLIANT ones could not be deleted until changed to DONE). An Editor can delete the requests she created herself, as long as they have no CM decision yet. Other people's requests, and any with a CM decision, are kept for her (a Manager or custom role with the Delete action can delete any request without a CM decision). The server checks every delete; the audit log records refused ones.
- **Rows per page: All (Ingest and Workload):** the Rows box next to the page buttons now has 25 / 50 / 100 / 200 / All in both trackers (remembered). All shows up to 3000 rows on one page; the page buttons reach the rest. Selecting a long page and deleting works in batches, and Save in the Excel grid sends a long page in batches of 200 rows.
- **Workload Tracker: Delete All:** Admins have a visible Delete All (… menu in the toolbar) that deletes every row matching the filters you have on, after typing DELETE. It was only reachable before by pressing Ctrl+A twice. Rows in a locked period are skipped.
- **Ingest Tracker: select all and delete all:** select a whole page (the row-number header, or Ctrl+A), then "Select all N matching" (or press Ctrl+A again) to select every request matching your filters on every page; Delete then asks you to type DELETE. An Admin deletes all of them; anyone else deletes the ones they may (their own without a CM decision) and the rest are kept, with the count shown. The audit log records one "Deleted Ingest Records (Select all)" entry with the filters used.
- **Plug list feeds the Workload Tracker for everyone:** importing the PSD Daily Plug List (or adding a plug by hand) now copies the new plugs into the Workload Tracker whoever does it, including an Editor who cannot see the Workload Tracker tab. Before, the copy only happened for people with Workload write access. The manual Copy button on the plug list still needs that access.
- **A Plug ID listed twice on one day gets two Workload rows:** the copy from the PSD Daily Plug List now makes one row per plug-list line, not one per Plug ID. The same ID listed twice on a day (for example with different PSDs) is two assignments, so both are kept, with their own PSD and Prog. Name. It still never doubles anything up: the Copy button counts the rows the day already has for that Plug ID and adds only the missing lines, so after updating, **Copy** on the plug list adds the repeats that were skipped before and a second Copy adds nothing.
- **Click-to-edit cells: the Date / Text dropdown and its box line up:** in the Workload Tracker table, editing Script, Artwork / STB or Audio Guide shows the Date / Text dropdown above the box. They are now the same width, one above the other, and centred in the cell like the value they replace (the box sat to the left and the two did not line up).
- **PSD Daily Plug List: select all and delete all (Admin):** select a page (the row-number header or Ctrl+A), then "Select all N in this view" (or Ctrl+A again) to select every plug in the current view on every page, or use **Delete All…** in the … menu to delete the whole list or just what the view shows (its days and search). Both ask you to type DELETE. Workload rows already made from the plugs are not touched. Selecting more than 1000 plugs by hand (e.g. with Rows set to All) now deletes in batches instead of failing with "Select at most 1000 plugs at a time".
- **Activity History logo:** the Activity History tab in the top bar now has an icon like the other tabs (a pulse line).
- **Groups: choose the Workload Tracker tabs:** in Admin > Groups, under *Workload Tracker*, tick which tabs the group sees (shown as *All Tab*, *VGFX Tab*, *VEDIT Tab*, *Audio Tab*; the section chips in the group list use the same look as the page chips): **All**, **VGFX**, **VEDIT**, **Audio**. A group that has the page but no tab ticked sees every tab (as before). A group without the All tab only gets rows of the teams it can see (rows whose Units Concerned is not set are in All only); the tabs, counts, list, export and bulk delete all follow it, and the server refuses a tab the group does not have. Admins always see everything.
- **Cells light up while someone edits them:** on the Workload Tracker and the Ingest Tracker, a cell another person has open is outlined in their colour (the same colour as their avatar at the top of the page), in real time. It clears when they leave the cell, and by itself after about 25 seconds if their browser closes.
- **Notification bell: live and animated:** a new notification now reaches the bell instantly (server push, like the trackers; the 30-second refresh stays as a safety net), and the bell rings and its badge pulses when the unread count goes up.
- **Ingest: Status (CM) only after approval:** DONE / NON-COMPLIANT can only be set once the material is approved. The Status (CM) cell and form field stay locked until then, and the server refuses it (a CM user can still clear a status back to Pending).
- **Ingest: approvers are told when something is waiting:** when the Destination Folder is filled in on an unapproved request, everyone who can approve (including Admins) gets a *For approval* notification. A new request that already has the folder says it is waiting for approval, and an Excel import sends one summary notification.
- **Plug list: notification when plugs are added:** everyone who can open the PSD Daily Plug List (except the person who added them) is notified when plugs are imported or added by hand, with how many and which date(s).
- **Workload Tracker: Fill from team workbook:** the team's original per-day workbook (sheets like `SEP 10_main`, with merged cells, banner rows and extra columns) can now fill the **blank cells** of rows already in the tracker, e.g. rows copied from the PSD Daily Plug List. Use the normal **Import** button and pick the team's workbook: Import recognises it (sheets with a `DATE:` line and a PLUG ID header) and, instead of adding rows, opens a window that checks the file and shows how many rows and cells would change (it re-checks when you change an option), then **Fill**. Any other file (this app's own Export) imports as before. Rows are matched by Work Date + Plug ID (only the ID itself is compared, so `PV_FIREWA_092926_LN015 - 24p` in the workbook matches `PV_FIREWA_092926_LN015`; one year is used for the whole workbook, worked out from the weekdays in the sheets' `DATE:` lines, so one sheet with a wrong weekday is outvoted). It fills PSD, Prog. Name, Breakdate (VGFX / VEDIT, from lines such as `VGFX: Sep 10, 10am`), VO, Script, Art/STB, Audio Guide, Remarks and Total Mats, sets **Units Concerned** from which of VGFX / VEDIT have a Breakdate line (a "Rehash" line follows the plug above it; a plug whose line names no team takes the team its other days name, if they all agree; and the **Units Concerned for plugs the workbook doesn't name a team for** box in the window can set one value, e.g. VGFX/VEDIT, for the rest — it is Leave blank unless you pick one), and turns on Priority when the cell says PRIO. A note in the Breakdate cell that is not a date (e.g. `STANDBY FOR REHASH`) is added to a blank Remarks. Typed values are never overwritten, no rows or columns are created, locked dates are skipped, and running it again changes nothing. The `_backup` sheets are used only for a plug the day's `_main` sheet does not list. A plug the plug list gives without its length (`PH_REDBAL_BALIMA_LNXX`, `PN_SATURD_101026_`) matches the workbook's one with a length (`..._LN060`) when it is the only plug of that name that day; a plug whose length differs (`LN030` in the plug list, `LN015` / `LN035` in the workbook) matches the same way, unless the workbook's exact plug is another row's own; a dash typed for the underscore (`..._092726-LN015`) is read as the underscore. If a plug's own day has no sheet entry at all, the **same plug from the nearest day that lists it** fills the row (not its Breakdate or Priority, which belong to that day); untick that box in the window to turn it off. The Audio (`_ojo`) sheets fill **Length**, **Remarks** (Details) and **Status**, and the Units Concerned of a plug no main sheet lists (Audio - RADIO, Audio - TV, or Audio – AUDIO GUIDE when the details say so). It is recorded in the Audit Log.
- **Notifications button wording:** the bell's "Mark all read" button now says "Mark all as read".

### App name

The name set in Administration → Branding is used everywhere, including the places the browser reads before the app loads: the tab title, the installed-app (PWA) name and home-screen label (`/manifest.webmanifest` is generated from it; the label is the name cut to about 12 characters at a word boundary), and the offline page. An already-installed PWA picks up a new name the next time the browser refreshes its manifest (reinstall to force it).
